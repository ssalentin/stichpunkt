import { escapeHtml } from './markdown';
import type { CollectionStore } from './collections';

/**
 * Renders a ```` ```database ```` block on a page.
 *
 * The page is a pointer, the collection is canonical: the block only says which collection to
 * show. The table is read-only and always current, because it is rendered from the store on every
 * request. Edits happen at `/databases/<id>`; the block links there.
 */
export const DATABASE_BLOCK_LIMIT = 200;

/** `collection: Bücher` or a bare `Bücher` on the first line. */
export function parseDatabaseBlock(source: string): string {
	const first = source
		.split('\n')
		.map((line) => line.trim())
		.find((line) => line !== '' && !line.startsWith('#'));
	if (!first) throw new Error('The block needs a collection name, e.g. "collection: Bücher".');
	const value = first.replace(/^collection\s*:\s*/i, '').trim();
	const name = value.replace(/^["']|["']$/g, '').trim();
	if (!name) throw new Error('The block needs a collection name, e.g. "collection: Bücher".');
	return name;
}

function cell(value: unknown): string {
	if (value === null || value === undefined || value === '') return '<span class="muted">–</span>';
	if (Array.isArray(value)) return value.map((v) => escapeHtml(String(v))).join(', ');
	return escapeHtml(String(value));
}

export function renderDatabaseBlock(store: CollectionStore, source: string): string {
	const name = parseDatabaseBlock(source);
	const collection = store.list().find((c) => c.name.toLowerCase() === name.toLowerCase());
	if (!collection) {
		return `<div class="db-block error"><p><strong>Sammlung „${escapeHtml(name)}“ nicht gefunden.</strong></p><pre><code>${escapeHtml(source)}</code></pre></div>`;
	}
	const props = collection.properties ?? [];
	const result = store.query(collection.id, { limit: DATABASE_BLOCK_LIMIT });
	const head = props.map((p) => `<th>${escapeHtml(p.name)}</th>`).join('');
	const body = result.rows
		.map((row) => `<tr>${props.map((p) => `<td>${cell((row.values as Record<string, unknown>)[p.name])}</td>`).join('')}</tr>`)
		.join('');
	const more = result.total > result.rows.length ? `<p class="muted">${result.rows.length} von ${result.total} Zeilen. Alle Zeilen in der Datenbankansicht.</p>` : '';
	return [
		'<div class="db-block">',
		`<div class="db-head"><span class="db-name">${escapeHtml(collection.name)}</span>`,
		`<a class="db-open" href="/databases/${encodeURIComponent(collection.id)}">Öffnen</a></div>`,
		'<div class="db-scroll"><table>',
		`<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`,
		more,
		'</div>'
	].join('');
}

export function renderDatabaseError(source: string, message: string): string {
	return `<div class="db-block error"><p><strong>${escapeHtml(message)}</strong></p><pre><code>${escapeHtml(source)}</code></pre></div>`;
}
