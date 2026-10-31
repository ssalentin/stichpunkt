import { json } from '@sveltejs/kit';
import { getCollections } from '#lib/server/collection-service';
import { getMdwiki } from '#lib/server/service';
import { fail, readJson } from '#lib/server/http';
import { parseMarkdownTables, previewTable } from '#lib/server/collections-import';
import type { RequestHandler } from './$types';

function typed(raw: string, type: string): unknown {
	const value = raw.trim();
	if (value === '' || value === '—' || value === '-') return type === 'multi_select' ? [] : null;
	if (type === 'number') {
		const n = Number(value.replace(/\s/g, '').replace(',', '.'));
		return Number.isFinite(n) ? n : value;
	}
	if (type === 'checkbox') return /^(true|ja|yes|✓)$/i.test(value);
	if (type === 'url') return /^https?:\/\//.test(value) ? value : null;
	return value;
}

/**
 * Import one Markdown table into a new collection. Body:
 * { path, table, name?, columns?: [{name,type}], dry_run? }
 * Only the collection store is written; the page itself is left untouched.
 */
export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await readJson(request, 64 * 1024);
		const page = typeof body.path === 'string' ? body.path : '';
		const mdwiki = await getMdwiki();
		const view = await mdwiki.readPage(page);
		const tables = parseMarkdownTables(view.content);
		const table = tables.find((t) => t.index === Number(body.table));
		if (!table) return json({ error: 'not_found', message: `Table ${String(body.table)} does not exist on "${page}"` }, { status: 404 });
		const preview = previewTable(page, table);
		const columns = Array.isArray(body.columns) && body.columns.length
			? (body.columns as { name: string; type: string }[])
			: preview.columns;
		const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : preview.name;
		if (body.dry_run === true) return json({ dry_run: true, name, columns, rows: table.rows.length });

		const store = getCollections();
		const collection = store.create({ name, properties: columns });
		const byName = new Map(columns.map((c) => [c.name, c.type]));
		let imported = 0;
		for (const row of table.rows) {
			const values: Record<string, unknown> = {};
			columns.forEach((column, i) => {
				values[column.name] = typed(row[i] ?? '', byName.get(column.name) ?? 'text');
			});
			store.createRow(collection.id, values, 'import');
			imported++;
		}
		return json({ dry_run: false, collection: store.get(collection.id), imported }, { status: 201 });
	} catch (e) {
		return fail(e);
	}
};
