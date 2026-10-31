import { escapeHtml } from './markdown';
import type { CollectionStore, Property } from './collections';

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

/**
 * A link target for a cell value, or null. Only http(s) and plain mail addresses become links:
 * a `javascript:` or `data:` value in a database row must never turn into an href.
 */
function linkFor(prop: Property, text: string): string | null {
	if (prop.type === 'url') {
		try {
			const url = new URL(text);
			return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
		} catch {
			return null;
		}
	}
	if (prop.type === 'email') {
		const value = text.trim();
		return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) ? `mailto:${value}` : null;
	}
	return null;
}

/** The visible label: a URL loses its scheme, everything else stays as stored. */
function labelFor(prop: Property, text: string): string {
	return prop.type === 'url' ? text.replace(/^https?:\/\//i, '') : text;
}

function cell(value: unknown, prop: Property): string {
	if (value === null || value === undefined || value === '') return '<span class="muted">–</span>';
	if (Array.isArray(value)) return value.map((v) => escapeHtml(String(v))).join(', ');
	const text = String(value);
	const href = linkFor(prop, text);
	if (href) {
		return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(text)}">${escapeHtml(labelFor(prop, text))}</a>`;
	}
	return escapeHtml(text);
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
		.map((row) => `<tr>${props.map((p) => `<td>${cell((row.values as Record<string, unknown>)[p.name], p)}</td>`).join('')}</tr>`)
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
