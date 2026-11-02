import type { CollectionStore, Property, RowRecord } from './collections';

/**
 * Portable export of one collection as JSON or CSV.
 *
 * The database is canonical, so there has to be a way out that does not depend on the service
 * running: JSON keeps the property types and row ids, CSV is the shape a spreadsheet or the
 * Markdown-table import expects. Both are read-only snapshots; export never writes to the store.
 */

export const EXPORT_VERSION = 1;

const PAGE_SIZE = 500;

export interface CollectionExport {
	format: 'stichpunkt-collection';
	version: number;
	exported_at: string;
	collection: {
		id: string;
		name: string;
		icon: string | null;
		properties: Array<{ name: string; type: string; options: string[] | null }>;
	};
	rows: Array<{ id: string; created_at: string; updated_at: string; values: Record<string, unknown> }>;
}

/** Reads every row of a collection, paging past the query API's per-request limit. */
export function readAllRows(store: CollectionStore, collectionId: string): RowRecord[] {
	const rows: RowRecord[] = [];
	for (let offset = 0; ; offset += PAGE_SIZE) {
		const page = store.query(collectionId, { limit: PAGE_SIZE, offset });
		rows.push(...page.rows);
		if (page.rows.length < PAGE_SIZE || rows.length >= page.total) return rows;
	}
}

export function exportCollection(store: CollectionStore, collectionId: string, now = new Date()): CollectionExport {
	const collection = store.get(collectionId);
	return {
		format: 'stichpunkt-collection',
		version: EXPORT_VERSION,
		exported_at: now.toISOString(),
		collection: {
			id: collection.id,
			name: collection.name,
			icon: collection.icon,
			properties: collection.properties.map((p) => ({ name: p.name, type: p.type, options: p.options }))
		},
		rows: readAllRows(store, collectionId).map((row) => ({
			id: row.id,
			created_at: row.created_at,
			updated_at: row.updated_at,
			values: row.values
		}))
	};
}

/** RFC 4180: quote on separator, quote, or line break; double embedded quotes. */
function csvCell(value: unknown): string {
	if (value === null || value === undefined) return '';
	const text = Array.isArray(value) ? value.join(', ') : typeof value === 'boolean' ? String(value) : String(value);
	if (!/[",\r\n]/.test(text) && text === text.trim()) return text;
	return `"${text.replaceAll('"', '""')}"`;
}

export function toCsv(properties: Property[], rows: RowRecord[]): string {
	const header = properties.map((p) => csvCell(p.name)).join(',');
	const lines = rows.map((row) => properties.map((p) => csvCell(row.values[p.name])).join(','));
	return [header, ...lines].join('\r\n') + '\r\n';
}

export function exportCollectionCsv(store: CollectionStore, collectionId: string): string {
	const collection = store.get(collectionId);
	return toCsv(collection.properties, readAllRows(store, collectionId));
}

/** ASCII slug plus the full name in the RFC 5987 form, so umlauts survive the header. */
export function exportFilename(name: string, format: 'json' | 'csv'): { ascii: string; encoded: string } {
	const ascii = name
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^A-Za-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60) || 'collection';
	const encoded = encodeURIComponent(`${name}.${format}`).replace(
		/[!'()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
	);
	return { ascii: `${ascii}.${format}`, encoded };
}
