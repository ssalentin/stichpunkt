import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MdwikiError } from './errors';
import { runMigrations } from './migrations';

/**
 * SQLite-backed collections ("databases") behind the app.
 *
 * The database file is app state, not content: it lives on local disk
 * (`/var/lib/stichpunkt/collections.sqlite` by default, override with `COLLECTIONS_DB`), never on
 * the rclone-mounted space. SQLite over FUSE is ~29x slower per write and a dropped mount during a
 * transaction corrupts the file. The space stays the single content root, so this is not a second
 * mount — only the index and the rows live next to the service. The schema is normalised
 * (collection, property, row, cell, view, revision), values are typed through their property, and
 * every query is parameterised.
 */

export const PROPERTY_TYPES = ['title', 'text', 'number', 'select', 'multi_select', 'date', 'checkbox', 'url', 'email'] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export const FILTER_OPS = [
	'eq',
	'neq',
	'contains',
	'not_contains',
	'starts_with',
	'ends_with',
	'gt',
	'gte',
	'lt',
	'lte',
	'is_empty',
	'is_not_empty',
	'any_of',
	'none_of'
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/** Aggregate functions for view footers. `count` is the row count, `count_values` the filled cells. */
export const AGGREGATE_FNS = ['count', 'count_values', 'sum', 'min', 'max', 'average'] as const;
export type AggregateFn = (typeof AGGREGATE_FNS)[number];

export interface GroupBy {
	property: string;
	direction: 'asc' | 'desc';
}

/** group_by as accepted on the wire: direction is optional and defaults to asc. */
export type GroupByInput = { property: string; direction?: 'asc' | 'desc' };

/** Column aggregates keyed by property name. */
export type Aggregates = Record<string, AggregateFn>;

export interface GroupInfo {
	/** Raw stored cell value; date truncated to the day; checkbox 'true'/'false'; empty and missing cells are null. */
	key: string | null;
	count: number;
}

export interface Property {
	id: string;
	name: string;
	type: PropertyType;
	options: string[] | null;
	position: number;
}

export interface Filter {
	property: string;
	op: FilterOp;
	value?: unknown;
}

export interface Sort {
	property: string;
	direction: 'asc' | 'desc';
}

export interface CollectionView {
	id: string;
	name: string;
	filters: Filter[];
	sorts: Sort[];
	columns: string[] | null;
	group_by: GroupBy | null;
	aggregates: Aggregates;
	position: number;
}

export interface Collection {
	id: string;
	name: string;
	icon: string | null;
	created_at: string;
	updated_at: string;
	properties: Property[];
}

export interface CollectionSummary extends Collection {
	row_count: number;
	view_count: number;
}

export type CellValues = Record<string, unknown>;

export interface RowRecord {
	id: string;
	created_at: string;
	updated_at: string;
	values: Record<string, unknown>;
}

export interface RowQuery {
	filters?: Filter[];
	sorts?: Sort[];
	limit?: number;
	offset?: number;
	view?: string;
	/** undefined falls back to the view's group_by; explicit null disables grouping. */
	group_by?: GroupByInput | null;
	/** undefined falls back to the view's aggregates; explicit null or {} disables aggregates. */
	aggregates?: Aggregates | null;
}

export interface BulkTarget {
	row_id: string;
	base_updated_at?: string;
}

export interface BulkResult {
	batch_id: string;
	updated: number;
	would_update?: number;
}

export interface UndoResult {
	batch_id: string;
	undone: number;
	would_undo?: number;
}

export interface BatchSummary {
	batch_id: string;
	at: string;
	actor: string;
	row_count: number;
	undone: boolean;
}

export class CollectionError extends MdwikiError {
	constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
		super(status, code, message, details);
		this.name = 'CollectionError';
	}
}

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;
const MAX_FILTERS = 20;
const MAX_SORTS = 5;
/** Ceiling on aggregate entries per view; the UI builds its defaults under the same cap. */
export const MAX_AGGREGATES = 20;

/** A dry run runs the checks inside the transaction and then rolls back through this sentinel. */
const DRY_RUN = Symbol('collections-dry-run');

/** Cell equality: an absent key and a null value both mean "empty cell". */
function cellEq(a: unknown, b: unknown): boolean {
	return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
}

/** The property names whose stored values differ between two full-row snapshots. */
function changedCellKeys(before: CellValues, after: CellValues): string[] {
	const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
	return keys.filter((k) => !cellEq(before[k], after[k]));
}

function parseRevisionValues(raw: unknown): CellValues {
	if (typeof raw !== 'string' || !raw) return {};
	return JSON.parse(raw) as CellValues;
}

function nowIso(now = new Date()): string {
	return now.toISOString();
}

function fail(status: number, code: string, message: string, details?: Record<string, unknown>): never {
	throw new CollectionError(status, code, message, details);
}

function asString(value: unknown, what: string, max = 200): string {
	if (typeof value !== 'string' || value.trim() === '') fail(400, 'bad_request', `${what} must be a non-empty string`);
	const s = value.trim();
	if (s.length > max) fail(400, 'bad_request', `${what} is longer than ${max} characters`);
	return s;
}

function optionalIcon(value: unknown): string | null {
	if (value === undefined || value === null || value === '') return null;
	if (typeof value !== 'string' || value.length > 8) fail(400, 'bad_request', 'icon must be a short string');
	return value;
}

function parseOptions(raw: unknown): string[] | null {
	if (raw === undefined || raw === null) return null;
	if (!Array.isArray(raw) || raw.length > 200) fail(400, 'bad_request', 'options must be an array of strings');
	const out = raw.map((o) => asString(o, 'option', 80));
	return [...new Set(out)];
}

function parseFilters(raw: unknown): Filter[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw) || raw.length > MAX_FILTERS) fail(400, 'bad_filter', `filters must be an array of at most ${MAX_FILTERS}`);
	return raw.map((entry, i) => {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(400, 'bad_filter', `filters[${i}] must be an object`);
		const f = entry as Record<string, unknown>;
		const property = asString(f.property, `filters[${i}].property`);
		if (typeof f.op !== 'string' || !(FILTER_OPS as readonly string[]).includes(f.op)) {
			fail(400, 'bad_filter', `filters[${i}].op must be one of ${FILTER_OPS.join(', ')}`);
		}
		return { property, op: f.op as FilterOp, value: f.value };
	});
}

function parseSorts(raw: unknown): Sort[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw) || raw.length > MAX_SORTS) fail(400, 'bad_sort', `sorts must be an array of at most ${MAX_SORTS}`);
	return raw.map((entry, i) => {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(400, 'bad_sort', `sorts[${i}] must be an object`);
		const s = entry as Record<string, unknown>;
		const property = asString(s.property, `sorts[${i}].property`);
		const direction = s.direction ?? 'asc';
		if (direction !== 'asc' && direction !== 'desc') fail(400, 'bad_sort', `sorts[${i}].direction must be asc or desc`);
		return { property, direction };
	});
}

function parseColumns(raw: unknown): string[] | null {
	if (raw === undefined || raw === null) return null;
	if (!Array.isArray(raw) || raw.length > 50) fail(400, 'bad_view', 'columns must be an array of property names');
	return raw.map((c) => asString(c, 'column', 80));
}

/** At most one group_by; null and undefined both mean "no grouping". */
function parseGroupBy(raw: unknown): GroupBy | null {
	if (raw === undefined || raw === null) return null;
	if (typeof raw !== 'object' || Array.isArray(raw)) fail(400, 'bad_group', 'group_by must be an object with a property');
	const g = raw as Record<string, unknown>;
	const property = asString(g.property, 'group_by.property');
	const direction = g.direction ?? 'asc';
	if (direction !== 'asc' && direction !== 'desc') fail(400, 'bad_group', 'group_by.direction must be asc or desc');
	return { property, direction };
}

function parseAggregates(raw: unknown): Aggregates {
	if (raw === undefined || raw === null) return {};
	if (typeof raw !== 'object' || Array.isArray(raw)) fail(400, 'bad_aggregate', 'aggregates must be an object of property names to functions');
	const entries = Object.entries(raw as Record<string, unknown>);
	if (entries.length > MAX_AGGREGATES) fail(400, 'bad_aggregate', `aggregates must have at most ${MAX_AGGREGATES} entries`);
	const out: Aggregates = {};
	for (const [property, fn] of entries) {
		const name = asString(property, 'aggregate property', 80);
		if (typeof fn !== 'string' || !(AGGREGATE_FNS as readonly string[]).includes(fn)) {
			fail(400, 'bad_aggregate', `aggregates["${property}"] must be one of ${AGGREGATE_FNS.join(', ')}`);
		}
		out[name] = fn as AggregateFn;
	}
	return out;
}

/** Per-type allowances: count/count_values always; sum/average numbers; min/max ordered scalars. */
export function aggregateAllowed(fn: AggregateFn, type: PropertyType): boolean {
	if (fn === 'count' || fn === 'count_values') return true;
	if (fn === 'sum' || fn === 'average') return type === 'number';
	return type === 'number' || type === 'date' || type === 'text' || type === 'title' || type === 'url' || type === 'email';
}

/** Bulk targets: 1..500 rows, deduplicated by row id; the cap follows `MAX_LIMIT`. */
function parseBulkTargets(raw: unknown): BulkTarget[] {
	if (!Array.isArray(raw)) fail(400, 'bad_request', 'rows must be an array');
	const out: BulkTarget[] = [];
	const seen = new Set<string>();
	raw.forEach((entry, i) => {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(400, 'bad_request', `rows[${i}] must be an object`);
		const e = entry as Record<string, unknown>;
		const rowId = asString(e.row_id, `rows[${i}].row_id`, 80);
		if (seen.has(rowId)) return;
		seen.add(rowId);
		const target: BulkTarget = { row_id: rowId };
		if (e.base_updated_at !== undefined && e.base_updated_at !== null) {
			if (typeof e.base_updated_at !== 'string' || !e.base_updated_at) fail(400, 'bad_request', `rows[${i}].base_updated_at must be a string`);
			target.base_updated_at = e.base_updated_at;
		}
		out.push(target);
	});
	if (out.length === 0) fail(400, 'bad_request', 'rows must name at least one row');
	if (out.length > MAX_LIMIT) fail(400, 'bad_request', `a batch changes at most ${MAX_LIMIT} rows`);
	return out;
}

function clampLimit(n: unknown): number {
	const v = Number(n);
	if (!Number.isFinite(v) || v <= 0) return DEFAULT_LIMIT;
	return Math.min(Math.floor(v), MAX_LIMIT);
}

export class CollectionStore {
	private readonly db: DatabaseSync;
	private readonly listeners = new Set<(collectionId: string) => void>();

	private constructor(
		readonly file: string,
		db: DatabaseSync
	) {
		this.db = db;
	}

	/**
	 * Opens (and creates) the store; `:memory:` is supported for tests.
	 *
	 * Schema migrations run here, before the store is handed out. A failing migration closes the
	 * handle and throws, so the process does not serve against a half-migrated database.
	 */
	static open(file: string): CollectionStore {
		if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
		const exists = file !== ':memory:' && fs.existsSync(file) && fs.statSync(file).size > 0;
		const db = new DatabaseSync(file);
		try {
			db.exec('PRAGMA journal_mode = WAL;');
			db.exec('PRAGMA foreign_keys = ON;');
			db.exec('PRAGMA busy_timeout = 5000;');
			runMigrations(db, file, { backup: exists });
		} catch (e) {
			db.close();
			throw e;
		}
		return new CollectionStore(file, db);
	}

	close(): void {
		this.db.close();
	}

	/** Notifies live listeners after a write. Returns the unsubscribe function. */
	subscribe(fn: (collectionId: string) => void): () => void {
		this.listeners.add(fn);
		return () => void this.listeners.delete(fn);
	}

	private notify(collectionId: string): void {
		for (const fn of this.listeners) {
			try {
				fn(collectionId);
			} catch {
				/* a broken listener must not fail the write */
			}
		}
	}

	// ---- collections ---------------------------------------------------------------------

	list(): CollectionSummary[] {
		const rows = this.db.prepare('SELECT * FROM collection ORDER BY name COLLATE NOCASE').all() as Record<string, unknown>[];
		return rows.map((row) => {
			const id = row.id as string;
			return {
				...this.collectionFields(row),
				properties: this.properties(id),
				row_count: (this.db.prepare('SELECT count(*) AS n FROM "row" WHERE collection_id = ?').get(id) as { n: number }).n,
				view_count: (this.db.prepare('SELECT count(*) AS n FROM "view" WHERE collection_id = ?').get(id) as { n: number }).n
			};
		});
	}

	get(id: string): CollectionSummary {
		const row = this.db.prepare('SELECT * FROM collection WHERE id = ?').get(id) as Record<string, unknown> | undefined;
		if (!row) fail(404, 'not_found', `Collection "${id}" does not exist`);
		return {
			...this.collectionFields(row),
			properties: this.properties(id),
			row_count: (this.db.prepare('SELECT count(*) AS n FROM "row" WHERE collection_id = ?').get(id) as { n: number }).n,
			view_count: (this.db.prepare('SELECT count(*) AS n FROM "view" WHERE collection_id = ?').get(id) as { n: number }).n
		};
	}

	create(input: { name: unknown; icon?: unknown; properties: unknown }): CollectionSummary {
		const name = asString(input.name, 'name', 120);
		const icon = optionalIcon(input.icon);
		if (!Array.isArray(input.properties) || input.properties.length === 0) {
			fail(400, 'bad_request', 'properties must be a non-empty array');
		}
		if (input.properties.length > 100) fail(400, 'bad_request', 'at most 100 properties are allowed');
		const props = input.properties.map((raw, i) => this.propertyInput(raw, i));
		if (props.filter((p) => p.type === 'title').length !== 1) fail(400, 'bad_request', 'exactly one title property is required');
		if (new Set(props.map((p) => p.name.toLowerCase())).size !== props.length) fail(400, 'bad_request', 'property names must be unique');

		const id = randomUUID();
		const at = nowIso();
		this.transaction(() => {
			this.db.prepare('INSERT INTO collection (id, name, icon, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, name, icon, at, at);
			props.forEach((p, i) => {
				this.db
					.prepare('INSERT INTO property (id, collection_id, name, type, options, position) VALUES (?, ?, ?, ?, ?, ?)')
					.run(randomUUID(), id, p.name, p.type, p.options ? JSON.stringify(p.options) : null, i);
			});
		});
		this.notify(id);
		return this.get(id);
	}

	rename(id: string, input: { name?: unknown; icon?: unknown }): CollectionSummary {
		const current = this.get(id);
		const name = input.name === undefined ? current.name : asString(input.name, 'name', 120);
		const icon = input.icon === undefined ? current.icon : optionalIcon(input.icon);
		this.db.prepare('UPDATE collection SET name = ?, icon = ?, updated_at = ? WHERE id = ?').run(name, icon, nowIso(), id);
		this.notify(id);
		return this.get(id);
	}

	delete(id: string): void {
		const removed = this.db.prepare('DELETE FROM collection WHERE id = ?').run(id);
		if (Number(removed.changes) === 0) fail(404, 'not_found', `Collection "${id}" does not exist`);
		this.notify(id);
	}

	// ---- properties ----------------------------------------------------------------------

	properties(collectionId: string): Property[] {
		const rows = this.db
			.prepare('SELECT id, name, type, options, position FROM property WHERE collection_id = ? ORDER BY position, name')
			.all(collectionId) as Record<string, unknown>[];
		return rows.map((r) => ({
			id: r.id as string,
			name: r.name as string,
			type: r.type as PropertyType,
			options: r.options ? (JSON.parse(r.options as string) as string[]) : null,
			position: r.position as number
		}));
	}

	addProperty(collectionId: string, raw: unknown): Property {
		this.get(collectionId);
		const props = this.properties(collectionId);
		const input = this.propertyInput(raw, props.length);
		if (input.type === 'title') fail(400, 'bad_request', 'a collection has exactly one title property');
		if (props.some((p) => p.name.toLowerCase() === input.name.toLowerCase())) fail(409, 'conflict', 'a property with that name exists');
		const id = randomUUID();
		this.transaction(() => {
			this.db
				.prepare('INSERT INTO property (id, collection_id, name, type, options, position) VALUES (?, ?, ?, ?, ?, ?)')
				.run(id, collectionId, input.name, input.type, input.options ? JSON.stringify(input.options) : null, input.position);
			this.db.prepare('UPDATE collection SET updated_at = ? WHERE id = ?').run(nowIso(), collectionId);
		});
		this.notify(collectionId);
		return this.properties(collectionId).find((p) => p.id === id)!;
	}

	deleteProperty(collectionId: string, propertyId: string): void {
		const prop = this.properties(collectionId).find((p) => p.id === propertyId);
		if (!prop) fail(404, 'not_found', `Property "${propertyId}" does not exist`);
		if (prop.type === 'title') fail(400, 'bad_request', 'the title property cannot be deleted');
		this.transaction(() => {
			this.db.prepare('DELETE FROM property WHERE id = ? AND collection_id = ?').run(propertyId, collectionId);
			this.db.prepare('UPDATE collection SET updated_at = ? WHERE id = ?').run(nowIso(), collectionId);
		});
		this.notify(collectionId);
	}

	// ---- rows ----------------------------------------------------------------------------

	query(collectionId: string, input: RowQuery = {}): {
		rows: RowRecord[];
		total: number;
		properties: Property[];
		/** Group counts over the whole filtered set, null without grouping. */
		groups: GroupInfo[] | null;
		/** Column aggregates over the whole filtered set, null without aggregates. */
		aggregates: Record<string, { fn: AggregateFn; value: number | string | null }> | null;
	} {
		this.get(collectionId);
		const properties = this.properties(collectionId);
		const byName = new Map(properties.map((p) => [p.name.toLowerCase(), p]));
		const filters = parseFilters(input.filters);
		const sorts = parseSorts(input.sorts);
		const limit = clampLimit(input.limit);
		const offset = Math.max(0, Number(input.offset) || 0);
		// undefined falls back to the view's value; explicit null disables. Unlike the filters and
		// sorts fallback above (which fills empty lists), these are single settings checked per key.
		const requestGroup = input.group_by === undefined ? undefined : parseGroupBy(input.group_by);
		const requestAggregates = input.aggregates === undefined ? undefined : parseAggregates(input.aggregates);
		let groupBy = requestGroup ?? null;
		let groupIsView = false;
		let aggregates = requestAggregates ?? {};
		let aggregatesAreView = false;
		if (input.view) {
			const view = this.views(collectionId).find((v) => v.id === input.view);
			if (!view) fail(404, 'not_found', `View "${input.view}" does not exist`);
			if (!input.filters?.length) filters.push(...view.filters);
			if (!input.sorts?.length) sorts.push(...view.sorts);
			if (requestGroup === undefined && view.group_by) {
				groupBy = view.group_by;
				groupIsView = true;
			}
			if (requestAggregates === undefined) {
				aggregates = view.aggregates;
				aggregatesAreView = true;
			}
		}
		if (groupBy && !byName.has(groupBy.property.toLowerCase())) {
			// A saved view whose group property no longer exists is silently ignored; a request is a 400.
			if (!groupIsView) fail(400, 'bad_group', `Unknown property "${groupBy.property}"`);
			groupBy = null;
		}
		const keptAggregates: Aggregates = {};
		for (const [property, fn] of Object.entries(aggregates)) {
			const prop = byName.get(property.toLowerCase());
			if (!prop || !aggregateAllowed(fn, prop.type)) {
				if (aggregatesAreView) continue;
				fail(400, 'bad_aggregate', prop ? `"${fn}" is not supported for "${prop.name}" (${prop.type})` : `Unknown property "${property}"`);
			}
			keptAggregates[property] = fn;
		}
		aggregates = keptAggregates;

		const params: Record<string, string | number> = { collection: collectionId };
		const where: string[] = ['r.collection_id = @collection'];
		filters.forEach((filter, i) => {
			const prop = byName.get(filter.property.toLowerCase());
			if (!prop) fail(400, 'bad_filter', `Unknown property "${filter.property}"`);
			where.push(this.filterSql(prop, filter, i, params));
		});

		const order: string[] = [];
		const joins: string[] = [];
		let groupProp: Property | null = null;
		if (groupBy) {
			groupProp = byName.get(groupBy.property.toLowerCase())!;
			joins.push('LEFT JOIN cell g0 ON g0.row_id = r.id AND g0.property_id = @g0p');
			params.g0p = groupProp.id;
			const dir = groupBy.direction === 'desc' ? 'DESC' : 'ASC';
			// The group key leads the order: members of a group stay adjacent and the empty bucket
			// sorts last; the existing sorts still stack within each group.
			order.push(`${this.groupKeySql(groupProp, 'g0')} IS NULL`, `${this.orderExpr(groupProp, 'g0')} ${dir}`);
		}
		const aggregateEntries = Object.entries(aggregates).map(([property, fn]) => ({ property, fn, prop: byName.get(property.toLowerCase())! }));
		aggregateEntries.forEach((entry, i) => {
			joins.push(`LEFT JOIN cell a${i} ON a${i}.row_id = r.id AND a${i}.property_id = @a${i}p`);
			params[`a${i}p`] = entry.prop.id;
		});
		sorts.forEach((sort, i) => {
			const prop = byName.get(sort.property.toLowerCase());
			if (!prop) fail(400, 'bad_sort', `Unknown property "${sort.property}"`);
			joins.push(`LEFT JOIN cell s${i} ON s${i}.row_id = r.id AND s${i}.property_id = @s${i}p`);
			params[`s${i}p`] = prop.id;
			const dir = sort.direction === 'desc' ? 'DESC' : 'ASC';
			order.push(`s${i}.value IS NULL, ${this.orderExpr(prop, `s${i}`)} ${dir}`);
		});
		order.push('r.position, r.id');

		const from = `FROM "row" r ${joins.join(' ')} WHERE ${where.join(' AND ')}`;
		const total = (this.db.prepare(`SELECT count(*) AS n ${from}`).get(params) as { n: number }).n;

		let groups: GroupInfo[] | null = null;
		if (groupBy && groupProp) {
			const key = this.groupKeySql(groupProp, 'g0');
			const dir = groupBy.direction === 'desc' ? 'DESC' : 'ASC';
			// Counts cover the whole filtered set, not the page, so a group split across pages keeps
			// its true count. Keys are constant per group, so the non-aggregate order terms are stable.
			const groupRows = this.db
				.prepare(`SELECT ${key} AS grp, count(*) AS n ${from} GROUP BY grp ORDER BY ${key} IS NULL, ${this.orderExpr(groupProp, 'g0')} ${dir}, grp`)
				.all(params) as { grp: string | null; n: number }[];
			groups = groupRows.map((g) => ({ key: g.grp, count: g.n }));
		}

		let aggregateValues: Record<string, { fn: AggregateFn; value: number | string | null }> | null = null;
		if (aggregateEntries.length > 0) {
			const select: string[] = [];
			aggregateEntries.forEach((entry, i) => {
				const filled = this.filledSql(`a${i}`);
				const jsonValue = `json_extract(a${i}.value, '$')`;
				if (entry.fn === 'count') select.push(`count(*) AS agg${i}`);
				else if (entry.fn === 'count_values') select.push(`count(CASE WHEN ${filled} THEN 1 END) AS agg${i}`);
				else if (entry.fn === 'sum' || entry.fn === 'average') select.push(`sum(CASE WHEN ${filled} THEN CAST(${jsonValue} AS REAL) END) AS agg${i}`);
				else {
					const typed = entry.prop.type === 'number' ? `CAST(${jsonValue} AS REAL)` : `CAST(${jsonValue} AS TEXT)`;
					select.push(`${entry.fn}(CASE WHEN ${filled} THEN ${typed} END) AS agg${i}`);
				}
				if (entry.fn === 'average') select.push(`count(CASE WHEN ${filled} THEN 1 END) AS agg${i}_n`);
			});
			const computed = this.db.prepare(`SELECT ${select.join(', ')} ${from}`).get(params) as Record<string, unknown>;
			aggregateValues = {};
			aggregateEntries.forEach((entry, i) => {
				const raw = computed[`agg${i}`];
				let value: number | string | null;
				if (raw === null || raw === undefined) value = null;
				else if (typeof raw === 'number') value = raw;
				else if (typeof raw === 'bigint') value = Number(raw);
				else value = String(raw);
				if (entry.fn === 'average') {
					const filled = Number(computed[`agg${i}_n`] ?? 0);
					value = filled > 0 && typeof value === 'number' ? value / filled : null;
				}
				aggregateValues![entry.property] = { fn: entry.fn, value };
			});
		}

		params.limit = limit;
		params.offset = offset;
		const rows = this.db
			.prepare(
				`SELECT r.id, r.created_at, r.updated_at,
					(SELECT json_group_object(p.name, json(c.value))
					   FROM cell c JOIN property p ON p.id = c.property_id
					  WHERE c.row_id = r.id) AS values_json
				 ${from} ORDER BY ${order.join(', ')} LIMIT @limit OFFSET @offset`
			)
			.all(params) as Record<string, unknown>[];

		return {
			properties,
			total,
			rows: rows.map((r) => ({
				id: r.id as string,
				created_at: r.created_at as string,
				updated_at: r.updated_at as string,
				values: r.values_json ? (JSON.parse(r.values_json as string) as Record<string, unknown>) : {}
			})),
			groups,
			aggregates: aggregateValues
		};
	}

	createRow(collectionId: string, values: unknown, actor = 'unknown'): RowRecord {
		const collection = this.get(collectionId);
		const properties = this.properties(collectionId);
		const parsed = this.values(properties, values);
		const id = randomUUID();
		const at = nowIso();
		const position = (this.db.prepare('SELECT coalesce(max(position), -1) + 1 AS n FROM "row" WHERE collection_id = ?').get(collectionId) as { n: number }).n;
		this.transaction(() => {
			this.db.prepare('INSERT INTO "row" (id, collection_id, created_at, updated_at, position) VALUES (?, ?, ?, ?, ?)').run(id, collectionId, at, at, position);
			this.writeCells(id, properties, parsed);
			this.record(collectionId, id, actor, 'create', null, parsed);
			this.db.prepare('UPDATE collection SET updated_at = ? WHERE id = ?').run(at, collectionId);
		});
		this.notify(collectionId);
		return this.getRow(collectionId, id, collection);
	}

	updateRow(collectionId: string, rowId: string, values: unknown, actor = 'unknown', baseUpdatedAt?: string): RowRecord {
		const collection = this.get(collectionId);
		const properties = this.properties(collectionId);
		const current = this.getRow(collectionId, rowId, collection);
		if (baseUpdatedAt && current.updated_at !== baseUpdatedAt) {
			fail(409, 'conflict', 'The row changed since it was loaded', { current: current.updated_at });
		}
		const patch = this.values(properties, values, true);
		const next = { ...current.values, ...patch };
		const at = nowIso();
		this.transaction(() => {
			this.writePatch(collectionId, rowId, properties, patch, at);
			this.record(collectionId, rowId, actor, 'update', current.values, next);
			this.db.prepare('UPDATE collection SET updated_at = ? WHERE id = ?').run(at, collectionId);
		});
		this.notify(collectionId);
		return this.getRow(collectionId, rowId, collection);
	}

	deleteRow(collectionId: string, rowId: string, actor = 'unknown'): void {
		const current = this.getRow(collectionId, rowId);
		this.transaction(() => {
			this.db.prepare('DELETE FROM "row" WHERE id = ? AND collection_id = ?').run(rowId, collectionId);
			this.record(collectionId, rowId, actor, 'delete', current.values, null);
			this.db.prepare('UPDATE collection SET updated_at = ? WHERE id = ?').run(nowIso(), collectionId);
		});
		this.notify(collectionId);
	}

	getRow(collectionId: string, rowId: string, collection?: CollectionSummary): RowRecord {
		const row = this.db.prepare('SELECT id, created_at, updated_at FROM "row" WHERE id = ? AND collection_id = ?').get(rowId, collectionId) as
			| Record<string, unknown>
			| undefined;
		if (!row) fail(404, 'not_found', `Row "${rowId}" does not exist`);
		const values: Record<string, unknown> = {};
		const cells = this.db
			.prepare('SELECT p.name, c.value FROM cell c JOIN property p ON p.id = c.property_id WHERE c.row_id = ?')
			.all(rowId) as { name: string; value: string }[];
		for (const cell of cells) values[cell.name] = JSON.parse(cell.value);
		void collection;
		return { id: row.id as string, created_at: row.created_at as string, updated_at: row.updated_at as string, values };
	}

	/**
	 * Every row of a collection, uncapped: `query()` keeps its 500-row limit for the UI, the
	 * search index needs all of them. Same existence checks and ordering as the other reads.
	 */
	allRows(collectionId: string): { properties: Property[]; rows: RowRecord[] } {
		this.get(collectionId);
		const properties = this.properties(collectionId);
		const rows = this.db
			.prepare(
				`SELECT r.id, r.created_at, r.updated_at,
					(SELECT json_group_object(p.name, json(c.value))
					   FROM cell c JOIN property p ON p.id = c.property_id
					  WHERE c.row_id = r.id) AS values_json
				 FROM "row" r WHERE r.collection_id = ? ORDER BY r.position, r.id`
			)
			.all(collectionId) as Record<string, unknown>[];
		return {
			properties,
			rows: rows.map((r) => ({
				id: r.id as string,
				created_at: r.created_at as string,
				updated_at: r.updated_at as string,
				values: r.values_json ? (JSON.parse(r.values_json as string) as Record<string, unknown>) : {}
			}))
		};
	}

	// ---- bulk edit and undo --------------------------------------------------------------

	/**
	 * Applies one partial patch to many rows as a single undoable batch. Everything validates
	 * before anything writes: every row must exist and every supplied `base_updated_at` must
	 * match, or the call fails with a named-row 409 and changes nothing. One revision per row,
	 * all sharing a `batch_id`; `dryRun` reports `would_update` and writes nothing.
	 */
	bulkUpdate(collectionId: string, input: { rows: BulkTarget[]; values: unknown; actor?: string; dryRun?: boolean }): BulkResult {
		this.get(collectionId);
		const properties = this.properties(collectionId);
		const targets = parseBulkTargets(input.rows);
		const patch = this.values(properties, input.values, true);
		if (Object.keys(patch).length === 0) fail(400, 'bad_values', 'values must change at least one property');
		const actor = input.actor ?? 'unknown';
		const dryRun = input.dryRun === true;
		const batchId = randomUUID();
		const at = nowIso();
		let updated = 0;
		try {
			this.transaction(() => {
				const currents = targets.map((t) => {
					const row = this.getRow(collectionId, t.row_id);
					if (t.base_updated_at && row.updated_at !== t.base_updated_at) {
						const title = this.titleValue(properties, row.values);
						fail(409, 'conflict', `Row "${title}" changed since it was loaded`, { row_id: row.id, title, current: row.updated_at });
					}
					return row;
				});
				updated = currents.length;
				if (dryRun) throw DRY_RUN;
				for (const row of currents) {
					this.writePatch(collectionId, row.id, properties, patch, at);
					this.record(collectionId, row.id, actor, 'update', row.values, { ...row.values, ...patch }, batchId, null);
				}
				this.db.prepare('UPDATE collection SET updated_at = ? WHERE id = ?').run(at, collectionId);
			});
		} catch (e) {
			if (e !== DRY_RUN) throw e;
		}
		if (!dryRun) this.notify(collectionId);
		return dryRun ? { batch_id: batchId, updated: 0, would_update: updated } : { batch_id: batchId, updated };
	}

	/**
	 * Undoes a bulk batch as one new batch. For every row of the batch and every property the
	 * batch changed, the row must still equal the batch result; a later individual edit or a
	 * deleted row aborts the undo with a named-row 409 and changes nothing. A batch can only be
	 * undone once; the undo carries `undo_of` and its own `batch_id`, so undoing an undo works
	 * the same way. `dryRun` reports `would_undo` and writes nothing.
	 */
	undoBatch(collectionId: string, batchId: string, actor = 'unknown', dryRun = false): UndoResult {
		this.get(collectionId);
		const properties = this.properties(collectionId);
		const source = asString(batchId, 'batch_id', 80);
		const undoId = randomUUID();
		const at = nowIso();
		let undone = 0;
		try {
			this.transaction(() => {
				const revisions = this.db
					.prepare('SELECT * FROM revision WHERE collection_id = ? AND batch_id = ? AND row_id IS NOT NULL ORDER BY id')
					.all(collectionId, source) as Record<string, unknown>[];
				if (revisions.length === 0) fail(404, 'batch_not_found', `Batch "${source}" does not exist`);
				if (this.db.prepare('SELECT 1 AS n FROM revision WHERE collection_id = ? AND undo_of = ? LIMIT 1').get(collectionId, source)) {
					fail(400, 'batch_undone', `Batch "${source}" was already undone`);
				}
				const steps = revisions.map((revision) => {
					const before = parseRevisionValues(revision.before);
					const after = parseRevisionValues(revision.after);
					const rowId = String(revision.row_id);
					let row: RowRecord;
					try {
						row = this.getRow(collectionId, rowId);
					} catch (e) {
						if (e instanceof CollectionError && e.status === 404) {
							const title = this.titleValue(properties, after);
							fail(409, 'conflict', `Row "${title}" changed since it was loaded`, { row_id: rowId, title, current: null });
						}
						throw e;
					}
					const patch: CellValues = {};
					for (const key of changedCellKeys(before, after)) {
						if (!properties.some((p) => p.name === key)) continue;
						if (!cellEq(row.values[key], after[key])) {
							const title = this.titleValue(properties, row.values);
							fail(409, 'conflict', `Row "${title}" changed since it was loaded`, { row_id: row.id, title, current: row.updated_at });
						}
						patch[key] = before[key] === undefined ? null : before[key];
					}
					return { row, patch };
				});
				undone = steps.length;
				if (dryRun) throw DRY_RUN;
				for (const { row, patch } of steps) {
					this.writePatch(collectionId, row.id, properties, patch, at);
					this.record(collectionId, row.id, actor || 'unknown', 'update', row.values, { ...row.values, ...patch }, undoId, source);
				}
				this.db.prepare('UPDATE collection SET updated_at = ? WHERE id = ?').run(at, collectionId);
			});
		} catch (e) {
			if (e !== DRY_RUN) throw e;
		}
		if (!dryRun) this.notify(collectionId);
		return dryRun ? { batch_id: source, undone: 0, would_undo: undone } : { batch_id: undoId, undone };
	}

	/** The bulk batches of a collection, newest first: when, who, how many rows, undone or not. */
	batches(collectionId: string, limit = 20): BatchSummary[] {
		this.get(collectionId);
		const capped = Math.min(Math.max(1, Math.floor(Number(limit) || 1)), MAX_LIMIT);
		const rows = this.db
			.prepare(
				`SELECT r.batch_id AS batch_id, MIN(r.at) AS at, MIN(r.actor) AS actor, COUNT(*) AS row_count,
				        EXISTS (SELECT 1 FROM revision u WHERE u.collection_id = r.collection_id AND u.undo_of = r.batch_id) AS undone
				 FROM revision r
				 WHERE r.collection_id = ? AND r.batch_id IS NOT NULL
				 GROUP BY r.batch_id
				 ORDER BY MAX(r.id) DESC
				 LIMIT ?`
			)
			.all(collectionId, capped) as Record<string, unknown>[];
		return rows.map((r) => ({
			batch_id: r.batch_id as string,
			at: r.at as string,
			actor: r.actor as string,
			row_count: Number(r.row_count),
			undone: Number(r.undone) === 1
		}));
	}

	// ---- views ---------------------------------------------------------------------------

	views(collectionId: string): CollectionView[] {
		const rows = this.db
			.prepare('SELECT * FROM "view" WHERE collection_id = ? ORDER BY position, name')
			.all(collectionId) as Record<string, unknown>[];
		return rows.map((r) => ({
			id: r.id as string,
			name: r.name as string,
			filters: parseFilters(JSON.parse(r.filters as string)),
			sorts: parseSorts(JSON.parse(r.sorts as string)),
			columns: r.columns ? (JSON.parse(r.columns as string) as string[]) : null,
			group_by: r.group_by ? parseGroupBy(JSON.parse(r.group_by as string)) : null,
			aggregates: r.aggregates ? (JSON.parse(r.aggregates as string) as Aggregates) : {},
			position: r.position as number
		}));
	}

	saveView(
		collectionId: string,
		input: {
			id?: unknown;
			name: unknown;
			filters?: unknown;
			sorts?: unknown;
			columns?: unknown;
			group_by?: unknown;
			aggregates?: unknown;
		}
	): CollectionView {
		this.get(collectionId);
		const name = asString(input.name, 'name', 80);
		const filters = parseFilters(input.filters);
		const sorts = parseSorts(input.sorts);
		const columns = parseColumns(input.columns);
		const groupBy = parseGroupBy(input.group_by);
		const aggregates = parseAggregates(input.aggregates);
		// A saved view must group and aggregate over properties that exist and allow the chosen
		// function; queries against it would 400 for every viewer otherwise.
		const byName = new Map(this.properties(collectionId).map((p) => [p.name.toLowerCase(), p]));
		if (groupBy && !byName.has(groupBy.property.toLowerCase())) fail(400, 'bad_group', `Unknown property "${groupBy.property}"`);
		for (const [property, fn] of Object.entries(aggregates)) {
			const prop = byName.get(property.toLowerCase());
			if (!prop) fail(400, 'bad_aggregate', `Unknown property "${property}"`);
			if (!aggregateAllowed(fn, prop.type)) fail(400, 'bad_aggregate', `"${fn}" is not supported for "${prop.name}" (${prop.type})`);
		}
		const groupJson = groupBy ? JSON.stringify(groupBy) : null;
		const aggregateJson = Object.keys(aggregates).length ? JSON.stringify(aggregates) : null;
		const at = nowIso();
		const existing = typeof input.id === 'string' ? this.views(collectionId).find((v) => v.id === input.id) : undefined;
		if (existing) {
			this.db
				.prepare('UPDATE "view" SET name = ?, filters = ?, sorts = ?, columns = ?, group_by = ?, aggregates = ? WHERE id = ? AND collection_id = ?')
				.run(
					name,
					JSON.stringify(filters),
					JSON.stringify(sorts),
					columns ? JSON.stringify(columns) : null,
					groupJson,
					aggregateJson,
					existing.id,
					collectionId
				);
			this.notify(collectionId);
			return this.views(collectionId).find((v) => v.id === existing.id)!;
		}
		const id = randomUUID();
		const position = (this.db.prepare('SELECT coalesce(max(position), -1) + 1 AS n FROM "view" WHERE collection_id = ?').get(collectionId) as { n: number }).n;
		this.db
			.prepare('INSERT INTO "view" (id, collection_id, name, filters, sorts, columns, group_by, aggregates, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
			.run(id, collectionId, name, JSON.stringify(filters), JSON.stringify(sorts), columns ? JSON.stringify(columns) : null, groupJson, aggregateJson, position);
		void at;
		this.notify(collectionId);
		return this.views(collectionId).find((v) => v.id === id)!;
	}

	deleteView(collectionId: string, viewId: string): void {
		const removed = this.db.prepare('DELETE FROM "view" WHERE id = ? AND collection_id = ?').run(viewId, collectionId);
		if (Number(removed.changes) === 0) fail(404, 'not_found', `View "${viewId}" does not exist`);
		this.notify(collectionId);
	}

	// ---- internals -----------------------------------------------------------------------

	private collectionFields(row: Record<string, unknown>): { id: string; name: string; icon: string | null; created_at: string; updated_at: string } {
		return {
			id: row.id as string,
			name: row.name as string,
			icon: (row.icon as string | null) ?? null,
			created_at: row.created_at as string,
			updated_at: row.updated_at as string
		};
	}

	private propertyInput(raw: unknown, position: number): { name: string; type: PropertyType; options: string[] | null; position: number } {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(400, 'bad_request', 'property must be an object');
		const p = raw as Record<string, unknown>;
		const name = asString(p.name, 'property name', 80);
		const type = p.type;
		if (typeof type !== 'string' || !(PROPERTY_TYPES as readonly string[]).includes(type)) {
			fail(400, 'bad_request', `property type must be one of ${PROPERTY_TYPES.join(', ')}`);
		}
		const options = type === 'select' || type === 'multi_select' ? parseOptions(p.options) : null;
		return { name, type: type as PropertyType, options, position };
	}

	/** Validates and normalises a values object against the properties; `partial` allows a patch. */
	private values(properties: Property[], raw: unknown, partial = false): CellValues {
		if (raw === undefined || raw === null) raw = {};
		if (typeof raw !== 'object' || Array.isArray(raw)) fail(400, 'bad_values', 'values must be an object');
		const input = raw as Record<string, unknown>;
		const byName = new Map(properties.map((p) => [p.name, p]));
		const out: CellValues = {};
		for (const key of Object.keys(input)) {
			if (!byName.has(key)) fail(400, 'bad_values', `Unknown property "${key}"`);
		}
		for (const prop of properties) {
			const present = Object.prototype.hasOwnProperty.call(input, prop.name);
			if (!present) {
				if (partial) continue;
				out[prop.name] = prop.type === 'multi_select' ? [] : null;
				continue;
			}
			out[prop.name] = this.cellValue(prop, input[prop.name]);
		}
		return out;
	}

	private cellValue(prop: Property, raw: unknown): unknown {
		if (raw === undefined || raw === null || raw === '') {
			if (prop.type === 'multi_select') return [];
			if (prop.type === 'checkbox') return false;
			return null;
		}
		switch (prop.type) {
			case 'number': {
				const n = typeof raw === 'number' ? raw : Number(raw);
				if (!Number.isFinite(n)) fail(400, 'bad_value', `"${prop.name}" must be a number`);
				return n;
			}
			case 'checkbox':
				if (typeof raw === 'boolean') return raw;
				if (raw === 0 || raw === 1) return Boolean(raw);
				if (raw === 'true' || raw === 'false') return raw === 'true';
				fail(400, 'bad_value', `"${prop.name}" must be a checkbox value`);
				break;
			case 'multi_select': {
				const list = Array.isArray(raw) ? raw : [raw];
				const values = list.map((v) => asString(v, prop.name, 80));
				if (prop.options && values.some((v) => !prop.options!.includes(v))) {
					fail(400, 'bad_value', `"${prop.name}" contains an option that is not defined`);
				}
				return values;
			}
			case 'select': {
				const value = asString(raw, prop.name, 80);
				if (prop.options && !prop.options.includes(value)) fail(400, 'bad_value', `"${prop.name}" is not a defined option`);
				return value;
			}
			case 'date': {
				const value = asString(raw, prop.name, 40);
				if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(value)) fail(400, 'bad_value', `"${prop.name}" must be an ISO date`);
				return value;
			}
			case 'url':
				return asString(raw, prop.name, 2000);
			case 'email': {
				const value = asString(raw, prop.name, 320);
				if (!/^[^@\s]+@[^@\s]+$/.test(value)) fail(400, 'bad_value', `"${prop.name}" must be an email address`);
				return value;
			}
			default:
				return asString(raw, prop.name, 10_000);
		}
	}

	private writeCells(rowId: string, properties: Property[], values: CellValues): void {
		for (const prop of properties) {
			const value = values[prop.name];
			if (value === null || value === undefined) continue;
			this.db.prepare('INSERT INTO cell (row_id, property_id, value) VALUES (?, ?, ?)').run(rowId, prop.id, JSON.stringify(value));
		}
	}

	/** The per-type ordering expression a sort on this property uses, without the NULLs-last term. */
	private orderExpr(prop: Property, alias: string): string {
		const jsonValue = `json_extract(${alias}.value, '$')`;
		if (prop.type === 'number') return `CAST(${jsonValue} AS REAL)`;
		if (prop.type === 'checkbox') return `CAST(${jsonValue} AS INTEGER)`;
		return `lower(CAST(${jsonValue} AS TEXT))`;
	}

	/** The "cell is filled" test, the same one is_empty and is_not_empty use. */
	private filledSql(alias: string): string {
		const jsonValue = `json_extract(${alias}.value, '$')`;
		return `${jsonValue} IS NOT NULL AND ${jsonValue} != '' AND ${jsonValue} != '[]'`;
	}

	/**
	 * The group key expression: the raw stored value; date truncated to the day; checkbox
	 * 'true'/'false'; multi_select the exact stored JSON combination (no per-option fan-out in v1);
	 * empty and missing cells NULL, which the UI renders as "(empty)".
	 */
	private groupKeySql(prop: Property, alias: string): string {
		const jsonValue = `json_extract(${alias}.value, '$')`;
		let raw: string;
		if (prop.type === 'date') raw = `substr(CAST(${jsonValue} AS TEXT), 1, 10)`;
		else if (prop.type === 'checkbox') raw = `CASE WHEN CAST(${jsonValue} AS INTEGER) = 1 THEN 'true' ELSE 'false' END`;
		else if (prop.type === 'multi_select') raw = `CAST(${alias}.value AS TEXT)`;
		else raw = `CAST(${jsonValue} AS TEXT)`;
		return `CASE WHEN ${this.filledSql(alias)} THEN (${raw}) END`;
	}

	/**
	 * Applies a partial patch to one row: upserts the cells it names, clears cells set to empty,
	 * bumps `updated_at`. Property names the collection no longer has are skipped — a batch can
	 * predate a deleted property, and its undo must not fail over a cell nobody can see.
	 */
	private writePatch(collectionId: string, rowId: string, properties: Property[], patch: CellValues, at: string): void {
		for (const [name, value] of Object.entries(patch)) {
			const prop = properties.find((p) => p.name === name);
			if (!prop) continue;
			if (value === null || value === undefined) {
				this.db.prepare('DELETE FROM cell WHERE row_id = ? AND property_id = ?').run(rowId, prop.id);
			} else {
				this.db
					.prepare('INSERT INTO cell (row_id, property_id, value) VALUES (?, ?, ?) ON CONFLICT(row_id, property_id) DO UPDATE SET value = excluded.value')
					.run(rowId, prop.id, JSON.stringify(value));
			}
		}
		this.db.prepare('UPDATE "row" SET updated_at = ? WHERE id = ? AND collection_id = ?').run(at, rowId, collectionId);
	}

	/** How a row is named in bulk conflict messages; a collection always has exactly one title property. */
	private titleValue(properties: Property[], values: CellValues): string {
		const title = properties.find((p) => p.type === 'title');
		const value = title ? values[title.name] : undefined;
		if (typeof value === 'string' && value.trim()) return value.trim();
		return '(untitled)';
	}

	private filterSql(prop: Property, filter: Filter, index: number, params: Record<string, unknown>): string {
		const id = `f${index}`;
		const valueKey = `v${index}`;
		const cellMatch = `c${index}.row_id = r.id AND c${index}.property_id = @${id}p`;
		const exists = `SELECT 1 FROM cell c${index} WHERE ${cellMatch}`;
		const jsonValue = `json_extract(c${index}.value, '$')`;
		const filled = this.filledSql(`c${index}`);
		const isArray = prop.type === 'multi_select';
		params[`${id}p`] = prop.id;

		switch (filter.op) {
			case 'is_empty':
				return `NOT EXISTS (SELECT 1 FROM cell c${index} WHERE ${cellMatch} AND ${filled})`;
			case 'is_not_empty':
				return `EXISTS (SELECT 1 FROM cell c${index} WHERE ${cellMatch} AND ${filled})`;
			case 'any_of':
			case 'none_of': {
				const values = Array.isArray(filter.value) ? filter.value : [filter.value];
				if (values.length === 0) return filter.op === 'none_of' ? '1 = 1' : '1 = 0';
				const keys = values.map((v, i) => {
					params[`${valueKey}_${i}`] = String(v).toLowerCase();
					return `@${valueKey}_${i}`;
				});
				const list = keys.join(', ');
				const inner = isArray
					? `EXISTS (SELECT 1 FROM json_each(c${index}.value) WHERE lower(CAST(value AS TEXT)) IN (${list}))`
					: `lower(CAST(${jsonValue} AS TEXT)) IN (${list})`;
				return `${filter.op === 'none_of' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM cell c${index} WHERE ${cellMatch} AND ${inner})`;
			}
			case 'neq':
				params[valueKey] = this.compareValue(prop, filter.value) as string | number;
				return `NOT EXISTS (SELECT 1 FROM cell c${index} WHERE ${cellMatch} AND ${this.binary(prop, 'eq', jsonValue, `@${valueKey}`)})`;
			default: {
				if (filter.value === undefined || filter.value === null) fail(400, 'bad_filter', `"${filter.property}" needs a value for ${filter.op}`);
				params[valueKey] = this.compareValue(prop, filter.value) as string | number;
				const sql = this.binary(prop, filter.op, jsonValue, `@${valueKey}`);
				return `EXISTS (SELECT 1 FROM cell c${index} WHERE ${cellMatch} AND ${sql})`;
			}
		}
	}

	private compareValue(prop: Property, value: unknown): unknown {
		if (prop.type === 'number') {
			const n = Number(value);
			if (!Number.isFinite(n)) fail(400, 'bad_filter', `"${prop.name}" needs a numeric value`);
			return n;
		}
		if (prop.type === 'checkbox') return value === true || value === 'true' || value === 1 ? 1 : 0;
		return String(value).toLowerCase();
	}

	private binary(prop: Property, op: string, jsonValue: string, placeholder: string): string {
		if (prop.type === 'number') {
			const cast = `CAST(${jsonValue} AS REAL)`;
			switch (op) {
				case 'eq':
					return `${cast} = CAST(${placeholder} AS REAL)`;
				case 'neq':
					return `${cast} != CAST(${placeholder} AS REAL)`;
				case 'gt':
					return `${cast} > CAST(${placeholder} AS REAL)`;
				case 'gte':
					return `${cast} >= CAST(${placeholder} AS REAL)`;
				case 'lt':
					return `${cast} < CAST(${placeholder} AS REAL)`;
				case 'lte':
					return `${cast} <= CAST(${placeholder} AS REAL)`;
				default:
					fail(400, 'bad_filter', `${op} is not supported for numbers`);
			}
		}
		if (op === 'eq' || op === 'neq') {
			const cmp = `lower(CAST(${jsonValue} AS TEXT)) ${op === 'eq' ? '=' : '!='} lower(${placeholder})`;
			return cmp;
		}
		if (prop.type === 'date' && ['gt', 'gte', 'lt', 'lte'].includes(op)) {
			const symbol = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[op as 'gt' | 'gte' | 'lt' | 'lte'];
			return `CAST(${jsonValue} AS TEXT) ${symbol} ${placeholder}`;
		}
		const haystack = `lower(CAST(${jsonValue} AS TEXT))`;
		switch (op) {
			case 'contains':
				return `instr(${haystack}, lower(${placeholder})) > 0`;
			case 'not_contains':
				return `instr(${haystack}, lower(${placeholder})) = 0`;
			case 'starts_with':
				return `instr(${haystack}, lower(${placeholder})) = 1`;
			case 'ends_with':
				return `substr(${haystack}, -length(${placeholder})) = lower(${placeholder})`;
			case 'gt':
				return `${haystack} > lower(${placeholder})`;
			case 'gte':
				return `${haystack} >= lower(${placeholder})`;
			case 'lt':
				return `${haystack} < lower(${placeholder})`;
			case 'lte':
				return `${haystack} <= lower(${placeholder})`;
			default:
				fail(400, 'bad_filter', `${op} is not supported for "${prop.name}"`);
		}
	}

	private record(
		collectionId: string,
		rowId: string | null,
		actor: string,
		op: string,
		before: unknown,
		after: unknown,
		batchId: string | null = null,
		undoOf: string | null = null
	): void {
		this.db
			.prepare('INSERT INTO revision (collection_id, row_id, at, actor, op, before, after, batch_id, undo_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
			.run(
				collectionId,
				rowId,
				nowIso(),
				actor || 'unknown',
				op,
				before === null || before === undefined ? null : JSON.stringify(before),
				after === null || after === undefined ? null : JSON.stringify(after),
				batchId,
				undoOf
			);
	}

	history(collectionId: string, rowId?: string, limit = 50, batchId?: string): Record<string, unknown>[] {
		const where = ['collection_id = ?'];
		const args: (string | number)[] = [collectionId];
		if (rowId) {
			where.push('row_id = ?');
			args.push(rowId);
		}
		if (batchId) {
			where.push('batch_id = ?');
			args.push(batchId);
		}
		args.push(limit);
		const rows = this.db.prepare(`SELECT * FROM revision WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...args) as Record<string, unknown>[];
		return rows.map((r) => ({
			id: r.id,
			row_id: r.row_id,
			at: r.at,
			actor: r.actor,
			op: r.op,
			before: r.before ? JSON.parse(r.before as string) : null,
			after: r.after ? JSON.parse(r.after as string) : null,
			batch_id: r.batch_id ?? null,
			undo_of: r.undo_of ?? null
		}));
	}

	private transaction(fn: () => void): void {
		this.db.exec('BEGIN IMMEDIATE');
		try {
			fn();
			this.db.exec('COMMIT');
		} catch (e) {
			try {
				this.db.exec('ROLLBACK');
			} catch {
				/* already rolled back */
			}
			throw e;
		}
	}
}

/** Local default, deliberately outside the space: see the note at the top of this file. */
export { COLLECTIONS_DB_DEFAULT, collectionsFile } from './collections-path';
