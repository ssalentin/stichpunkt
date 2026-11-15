import { fail, redirect } from '@sveltejs/kit';
import { getCollections } from '#lib/server/collection-service';
import { collectionWriteEnabled, collectionWriteRefusal } from '#lib/server/collection-write';
import {
	CollectionError,
	MAX_AGGREGATES,
	aggregateAllowed,
	type Aggregates,
	type BulkTarget,
	type CollectionView,
	type Filter,
	type GroupBy,
	type Property,
	type Sort
} from '#lib/server/collections';
import { MdwikiError } from '#lib/server/errors';
import { EMPTY_GROUP_KEY, groupKeyOf, parseCollapsedParam } from '#lib/group-key';
import type { Actions, PageServerLoad } from './$types';

const OPS = ['eq', 'neq', 'contains', 'not_contains', 'starts_with', 'ends_with', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty'] as const;
const MAX_FORM_BYTES = 512 * 1024;

/**
 * Resolve grouping and aggregates for one page load or view save. `groupInput` is the raw
 * `?group=` (or form) value: null means absent, then the view's group_by applies; an empty string
 * forces grouping off; a name overrides the view. Saved-view entries whose property no longer
 * exists, or whose function no longer fits the type, are dropped — never fatal. Active grouping
 * without a saved aggregates config uses the defaults: sum for numbers, count_values otherwise.
 */
function resolveGrouping(
	properties: Property[],
	selected: CollectionView | undefined,
	groupInput: string | null,
	columnNames: string[]
): { group_by: GroupBy | null; aggregates: Aggregates } {
	const byName = new Map(properties.map((p) => [p.name.toLowerCase(), p]));
	let group_by: GroupBy | null = null;
	if (groupInput === null) {
		if (selected?.group_by && byName.has(selected.group_by.property.toLowerCase())) group_by = selected.group_by;
	} else if (groupInput.trim()) {
		const prop = byName.get(groupInput.trim().toLowerCase());
		// an unknown explicit property stays as given: the store answers 400 bad_group, like unknown filters
		group_by = { property: prop ? prop.name : groupInput.trim(), direction: 'asc' };
	}
	const aggregates: Aggregates = {};
	for (const [name, fn] of Object.entries(selected?.aggregates ?? {})) {
		const prop = byName.get(name.toLowerCase());
		if (prop && aggregateAllowed(fn, prop.type)) aggregates[name] = fn;
	}
	if (group_by && Object.keys(aggregates).length === 0) {
		for (const name of columnNames) {
			if (Object.keys(aggregates).length >= MAX_AGGREGATES) break;
			const prop = byName.get(name.toLowerCase());
			if (prop) aggregates[name] = prop.type === 'number' ? 'sum' : 'count_values';
		}
	}
	return { group_by, aggregates };
}

/** Filters and sorts from the repeated `p{i}/o{i}/v{i}` and `sort=prop:dir` fields, load and form alike. */
function formQuery(get: (key: string) => string | undefined): { filters: Filter[]; sorts: Sort[] } {
	const filters: Filter[] = [];
	for (let i = 0; i < 3; i++) {
		const property = get(`p${i}`)?.trim();
		if (!property) continue;
		const op = get(`o${i}`) ?? 'contains';
		const value = get(`v${i}`) ?? '';
		filters.push({ property, op: op as Filter['op'], value: op === 'is_empty' || op === 'is_not_empty' ? undefined : value });
	}
	const sorts: Sort[] = [];
	const sortParam = get('sort') ?? '';
	if (sortParam.includes(':')) {
		const [property, direction] = sortParam.split(':');
		sorts.push({ property, direction: direction === 'desc' ? 'desc' : 'asc' });
	}
	return { filters, sorts };
}

export const load: PageServerLoad = async ({ params, url }) => {
	const store = getCollections();
	const collection = store.get(params.id);
	const views = store.views(params.id);
	const view = url.searchParams.get('view') ?? '';
	const { filters, sorts } = formQuery((key) => url.searchParams.get(key) ?? undefined);
	const selected = views.find((v) => v.id === view);
	const effectiveFilters = filters.length ? filters : (selected?.filters ?? []);
	const effectiveSorts = sorts.length ? sorts : (selected?.sorts ?? []);
	const columns = selected?.columns?.length ? selected.columns : collection.properties.map((p) => p.name);
	const grouping = resolveGrouping(collection.properties, selected, url.searchParams.get('group'), columns);
	const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500);
	const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
	const result = store.query(params.id, {
		filters: effectiveFilters,
		sorts: effectiveSorts,
		limit,
		offset,
		group_by: grouping.group_by,
		aggregates: grouping.aggregates
	});
	// Collapsed groups: member rows are hidden server-side; headers and counts come from `groups`,
	// which covers the whole filtered set, so a collapsed group still shows its true count.
	const collapsed = parseCollapsedParam(url.searchParams.get('collapsed'));
	const groupProp = grouping.group_by
		? collection.properties.find((p) => p.name.toLowerCase() === grouping.group_by!.property.toLowerCase())
		: undefined;
	const collapsedSet = new Set(collapsed);
	const rows = groupProp
		? result.rows.filter((row) => !collapsedSet.has(groupKeyOf(groupProp, row.values[groupProp.name]) ?? EMPTY_GROUP_KEY))
		: result.rows;
	const editId = url.searchParams.get('edit') ?? '';
	const creating = url.searchParams.get('new') === '1';
	let editing = null;
	if (editId) {
		try {
			editing = store.getRow(params.id, editId);
		} catch {
			editing = null;
		}
	}
	// Bulk changes are only interesting where they can be made, so the batch list rides the
	// same permission flag as the selection UI.
	const canEdit = collectionWriteEnabled();
	return {
		collection,
		views,
		view,
		columns,
		filters: effectiveFilters,
		sorts: effectiveSorts,
		ops: OPS,
		limit,
		offset,
		rows,
		total: result.total,
		groups: result.groups,
		aggregates: result.aggregates,
		group: grouping.group_by?.property ?? '',
		groupParam: url.searchParams.get('group'),
		collapsed,
		canEdit,
		editing,
		creating,
		saved: url.searchParams.get('saved') === '1',
		bulk: url.searchParams.get('bulk') === '1',
		batch: url.searchParams.get('batch') ?? '',
		batches: canEdit ? store.batches(params.id, 10) : []
	};
};

function valuesFromForm(form: FormData, properties: Property[]): Record<string, unknown> {
	const values: Record<string, unknown> = {};
	for (const prop of properties) {
		const raw = form.getAll(`p:${prop.name}`).map((v) => String(v));
		if (prop.type === 'checkbox') values[prop.name] = raw.includes('1');
		else if (prop.type === 'multi_select') values[prop.name] = raw.filter((v) => v !== '');
		else values[prop.name] = raw.length ? raw[raw.length - 1] : '';
	}
	return values;
}

function formTooLarge(form: FormData): boolean {
	let total = 0;
	for (const [, value] of form.entries()) {
		total += typeof value === 'string' ? value.length : value.size;
		if (total > MAX_FORM_BYTES) return true;
	}
	return false;
}

export const actions: Actions = {
	save: async ({ request, params, url }) => {
		const refusal = collectionWriteRefusal(request.headers);
		if (refusal) return fail(403, { error: refusal });
		const form = await request.formData();
		if (formTooLarge(form)) return fail(413, { error: 'The row is too large.' });
		const store = getCollections();
		const collection = store.get(params.id);
		const rowId = String(form.get('row_id') ?? '');
		const values = valuesFromForm(form, collection.properties);
		try {
			if (rowId) {
				const base = String(form.get('base_updated_at') ?? '');
				if (!base) return fail(400, { error: 'Missing row version. Reload and try again.' });
				store.updateRow(params.id, rowId, values, 'web-ui', base);
			} else {
				store.createRow(params.id, values, 'web-ui');
			}
		} catch (e) {
			if (e instanceof MdwikiError) {
				return fail(e.status === 409 ? 409 : 400, {
					error: e.status === 409 ? 'This row changed while you were editing. Reload and merge your changes.' : e.message
				});
			}
			throw e;
		}
		throw redirect(303, withFlag(url, 'saved'));
	},
	delete: async ({ request, params, url }) => {
		const refusal = collectionWriteRefusal(request.headers);
		if (refusal) return fail(403, { error: refusal });
		const form = await request.formData();
		const rowId = String(form.get('row_id') ?? '');
		if (!rowId) return fail(400, { error: 'Missing row.' });
		try {
			getCollections().deleteRow(params.id, rowId, 'web-ui');
		} catch (e) {
			if (e instanceof CollectionError) return fail(e.status, { error: e.message });
			throw e;
		}
		throw redirect(303, withFlag(url, 'saved'));
	},
	/** Minimal "Save view": persists the current filters, sorts and columns plus the active grouping. */
	saveView: async ({ request, params }) => {
		const refusal = collectionWriteRefusal(request.headers);
		if (refusal) return fail(403, { error: refusal });
		const form = await request.formData();
		if (formTooLarge(form)) return fail(413, { error: 'The form is too large.' });
		const store = getCollections();
		const collection = store.get(params.id);
		const { filters, sorts } = formQuery((key) => (form.has(key) ? String(form.get(key)) : undefined));
		const selected = store.views(params.id).find((v) => v.id === String(form.get('view') ?? ''));
		const columns = selected?.columns?.length ? selected.columns : collection.properties.map((p) => p.name);
		const groupInput = form.has('group') ? String(form.get('group')) : null;
		const grouping = resolveGrouping(collection.properties, selected, groupInput, columns);
		let view: CollectionView;
		try {
			view = store.saveView(params.id, { name: form.get('view_name'), filters, sorts, columns, ...grouping });
		} catch (e) {
			if (e instanceof MdwikiError) return fail(e.status, { error: e.message });
			throw e;
		}
		throw redirect(303, `/databases/${params.id}?view=${view.id}&saved=1`);
	},
	/** Applies one property to every ticked row as one batch; the redirect offers to undo it. */
	bulk: async ({ request, params, url }) => {
		const refusal = collectionWriteRefusal(request.headers);
		if (refusal) return fail(403, { error: refusal });
		const form = await request.formData();
		if (formTooLarge(form)) return fail(413, { error: 'Too many rows selected.' });
		const store = getCollections();
		const collection = store.get(params.id);
		const propertyName = String(form.get('property') ?? '');
		const property = collection.properties.find((p) => p.name === propertyName);
		if (!property) return fail(400, { error: 'Choose the property to change.' });
		if (property.type === 'title') return fail(400, { error: 'Bulk edit does not change titles.' });
		const ids = [...new Set(form.getAll('row_id').map(String).filter((id) => id))];
		if (ids.length === 0) return fail(400, { error: 'Select at least one row first.' });
		const targets: BulkTarget[] = ids.map((id) => {
			const base = String(form.get(`base:${id}`) ?? '');
			return base ? { row_id: id, base_updated_at: base } : { row_id: id };
		});
		let batchId = '';
		try {
			batchId = store.bulkUpdate(params.id, { rows: targets, values: valuesFromForm(form, [property]), actor: 'web-ui' }).batch_id;
		} catch (e) {
			if (e instanceof MdwikiError) return fail(e.status === 409 ? 409 : 400, { error: e.message });
			throw e;
		}
		throw redirect(303, withFlag(url, 'saved', batchId));
	},
	/** Reverses a bulk batch as a new batch; a row that moved since is named in the error. */
	undo: async ({ request, params, url }) => {
		const refusal = collectionWriteRefusal(request.headers);
		if (refusal) return fail(403, { error: refusal });
		const form = await request.formData();
		const batchId = String(form.get('batch_id') ?? '');
		if (!batchId) return fail(400, { error: 'Missing batch.' });
		let undoId = '';
		try {
			undoId = getCollections().undoBatch(params.id, batchId, 'web-ui').batch_id;
		} catch (e) {
			if (e instanceof CollectionError) return fail(e.status, { error: e.message });
			throw e;
		}
		throw redirect(303, withFlag(url, 'saved', undoId));
	}
};

/** Keep view/filter/sort, drop the editor state, add the confirmation flag and the batch it refers to. */
function withFlag(url: URL, flag: string, batch?: string): string {
	const next = new URL(url);
	next.searchParams.delete('edit');
	next.searchParams.delete('new');
	next.searchParams.delete('bulk');
	next.searchParams.set(flag, '1');
	if (batch) next.searchParams.set('batch', batch);
	else next.searchParams.delete('batch');
	return next.pathname + next.search;
}
