import { escapeHtml } from './markdown';
import { MAX_LIMIT, renderPagesResult, type PagesResult, type PagesRow } from './pages-query';
import type { SpaceIndex } from './space';
import type { LinkValue, PageValue, Value } from './expr';

/**
 * Rendering for expression results. Everything is escaped: a value never produces HTML, it only
 * produces text, a wikilink anchor, or the shared list renderer of the `pages` block.
 */

const e = escapeHtml;
const href = (path: string) => '/' + encodeURI(path);
const anchor = (path: string, label: string) => `<a class="wikilink" href="${href(path)}">${e(label)}</a>`;

const isPage = (v: Value): v is PageValue => typeof v === 'object' && v !== null && (v as PageValue).kind === 'page';
const isLink = (v: Value): v is LinkValue => typeof v === 'object' && v !== null && (v as LinkValue).kind === 'link';

/** Whole numbers print as-is, everything else is rounded to two places. */
function numberText(n: number): string {
	if (Number.isInteger(n)) return String(n);
	return String(Math.round(n * 100) / 100);
}

function scalarText(v: Value): string {
	if (v === null) return '';
	if (typeof v === 'boolean') return v ? 'true' : 'false';
	if (typeof v === 'number') return numberText(v);
	if (typeof v === 'string') return v;
	if (isPage(v)) return v.path;
	if (isLink(v)) return v.path;
	return '';
}

/** The muted dash shown for `null`. */
export const NULL_DASH = '<span class="expr-null muted">—</span>';

/** Rendered text form of a value; `null` becomes a muted dash, never HTML. */
export function renderValueText(v: Value): string {
	if (v === null) return NULL_DASH;
	if (v instanceof Date) return e(v.toISOString().slice(0, 10));
	if (typeof v === 'boolean') return e(v ? 'true' : 'false');
	if (typeof v === 'number') return e(numberText(v));
	if (typeof v === 'string') return e(v);
	if (isPage(v)) return anchor(v.path, v.title || v.path);
	if (isLink(v)) return anchor(v.path, v.label || v.path);
	if (Array.isArray(v)) {
		// a list of scalar values is comma-separated; anything else falls back to its text
		if (v.every((x) => !Array.isArray(x) && !(typeof x === 'object' && x !== null))) {
			return e(v.map((x) => scalarText(x)).join(', '));
		}
		return e(v.map((x) => scalarText(x)).join(', '));
	}
	// a record: key = value pairs, escaped
	const parts: string[] = [];
	for (const [k, val] of v.rec.entries()) parts.push(`${k}: ${scalarText(val)}`);
	return e(parts.join(', '));
}

/**
 * Renders a value as inline HTML for the page. A page list is delegated to the shared list
 * renderer of the `pages` block, so both look the same. This is what `evaluate` returns as
 * `text` too (as plain text), see {@link valueToText}.
 */
export function renderValue(v: Value): string {
	if (Array.isArray(v) && v.length > 0 && v.every(isPage)) return renderPageList(v);
	return renderValueText(v);
}

function renderPageList(pages: PageValue[]): string {
	const rows: PagesRow[] = pages.slice(0, MAX_LIMIT).map((p) => ({
		path: p.path,
		title: p.title,
		folder: p.folder,
		tags: p.tags,
		date: p.date,
		modified: p.modified,
		frontmatter: {}
	}));
	const result: PagesResult = { query: {}, show: 'list', columns: [], rows, total: pages.length };
	return renderPagesResult(result);
}

/** The `text` value returned by the `evaluate` MCP tool / REST route: plain text, no HTML. */
export function valueToText(v: Value): string {
	if (v === null) return '—';
	if (typeof v === 'boolean') return v ? 'true' : 'false';
	if (typeof v === 'number') return numberText(v);
	if (typeof v === 'string') return v;
	if (v instanceof Date) return v.toISOString().slice(0, 10);
	if (isPage(v)) return v.title || v.path;
	if (isLink(v)) return v.label || v.path;
	if (Array.isArray(v)) {
		if (v.length > 0 && v.every(isPage)) {
			return v.map((p) => p.title || p.path).join(', ');
		}
		return v.map((x) => valueToText(x)).join(', ');
	}
	return [...v.rec.entries()].map(([k, val]) => `${k}: ${valueToText(val)}`).join(', ');
}

/** JSON-safe projection of a value, for the `evaluate` tool and the REST route. */
export function valueToJson(v: Value, index?: SpaceIndex): unknown {
	if (v === null || typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') return v;
	if (v instanceof Date) return v.toISOString().slice(0, 10);
	if (isPage(v)) return { path: v.path, title: v.title, folder: v.folder, tags: v.tags, date: v.date, modified: v.modified };
	if (isLink(v)) return { link: v.path, label: v.label };
	if (Array.isArray(v)) return v.map((x) => valueToJson(x, index));
	const obj: Record<string, unknown> = {};
	for (const [k, val] of v.rec.entries()) obj[k] = valueToJson(val, index);
	return obj;
}
