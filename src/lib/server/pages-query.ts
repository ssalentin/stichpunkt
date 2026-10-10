import * as yaml from 'js-yaml';
import MarkdownIt from 'markdown-it';
import { z } from 'zod';
import type { PageRec, SpaceIndex } from './space';

/**
 * One declarative page query, as written in a fenced `pages` block or passed to the
 * `query_pages` tool / `POST /api/v1/query`. The body is a small YAML object; it is
 * parsed with the js-yaml CORE schema (as for frontmatter) and checked against the
 * schema below. Nothing here is executed: the query is a pure function over the index.
 */

/** Hard cap for `limit` (the spec allows a default of 50 and at most 200 rows). */
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/** `links-to` / `folder` may point at the current page instead of a literal name. */
export type ThisRef = 'this';

const nameOrThis = z.union([z.string().min(1), z.literal('this')]);

const sortDirection = z.enum(['asc', 'desc']);

export const SHOW_VALUES = ['list', 'table', 'count'] as const;
export type PagesShow = (typeof SHOW_VALUES)[number];

/** Column names that always exist; any other name is read from frontmatter. */
export const RESERVED_COLUMNS = ['title', 'folder', 'tags', 'modified', 'date'] as const;

/** A filter is only equality / prefix / exists / range. No regex, no expressions. */
export const pagesQuerySchema = z
	.object({
		tag: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
		folder: nameOrThis.optional(),
		'links-to': nameOrThis.optional(),
		sort: z.string().min(1).optional(),
		limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
		show: z.enum(SHOW_VALUES).optional(),
		columns: z.array(z.string().min(1)).min(1).max(12).optional()
	})
	.strict();

export type PagesQuery = z.infer<typeof pagesQuerySchema>;

export interface PagesRow {
	path: string;
	title: string;
	folder: string;
	tags: string[];
	date: string;
	modified: string;
	/** every frontmatter key, stringified for display */
	frontmatter: Record<string, string>;
}

export interface PagesResult {
	query: PagesQuery;
	show: PagesShow;
	columns: string[];
	/** rows after `limit` (always the full result for `show: count`) */
	rows: PagesRow[];
	/** number of matches before `limit` */
	total: number;
}

/** Raised for a malformed block; the message plus the source is shown in place of the block. */
export class PagesQueryError extends Error {
	constructor(
		message: string,
		readonly source: string
	) {
		super(message);
		this.name = 'PagesQueryError';
	}
}

const firstIssue = (issues: z.core.$ZodIssue[]): string => {
	const issue = issues[0];
	if (!issue) return 'Invalid query';
	const at = issue.path.length ? `${issue.path.join('.')}: ` : '';
	return `${at}${issue.message}`;
};

/**
 * Parses and validates the raw YAML body of a `pages` block. Throws {@link PagesQueryError}
 * (carrying the block source) for anything that is not a plain object with known keys.
 */
export function parsePagesBlock(source: string): PagesQuery {
	if (source.trim() === '') return {};
	let loaded: unknown;
	try {
		loaded = yaml.load(source, { schema: yaml.CORE_SCHEMA });
	} catch (e) {
		throw new PagesQueryError(`Invalid YAML: ${(e as Error).message}`, source);
	}
	if (loaded == null) return {};
	if (typeof loaded !== 'object' || Array.isArray(loaded)) {
		throw new PagesQueryError('The block body must be a YAML object', source);
	}
	const parsed = pagesQuerySchema.safeParse(loaded);
	if (!parsed.success) throw new PagesQueryError(firstIssue(parsed.error.issues), source);
	return parsed.data;
}

/** Validates a query object that arrived as JSON (MCP tool / REST), reusing the same schema. */
export function parsePagesQuery(input: unknown): PagesQuery {
	if (input == null) return {};
	if (typeof input !== 'object' || Array.isArray(input)) {
		throw new PagesQueryError('The query must be an object', JSON.stringify(input));
	}
	const parsed = pagesQuerySchema.safeParse(input);
	if (!parsed.success) throw new PagesQueryError(firstIssue(parsed.error.issues), JSON.stringify(input));
	return parsed.data;
}

const tagMatches = (pageTags: string[], wanted: string[]) =>
	wanted.every((w) => {
		const t = w.replace(/^#/, '').toLowerCase();
		return pageTags.some((x) => x === t || x.startsWith(t + '/'));
	});

const folderOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const dateOf = (p: PageRec) => (p.frontmatter.date == null ? '' : String(p.frontmatter.date));

/** Splits a `sort` value into key and direction; direction defaults to descending for dates, ascending otherwise. */
function parseSort(sort: string | undefined): { key: string; dir: 'asc' | 'desc' } {
	if (!sort) return { key: 'date', dir: 'desc' };
	const parts = sort.trim().split(/\s+/);
	const key = parts[0];
	const dir = parts[1] === 'asc' || parts[1] === 'desc' ? parts[1] : key === 'title' || key === 'path' ? 'asc' : 'desc';
	if (parts.length > 2 || (parts[1] && parts[1] !== 'asc' && parts[1] !== 'desc')) {
		throw new PagesQueryError(`Invalid sort direction in "${sort}" (use asc or desc)`, sort);
	}
	return { key, dir };
}

/** Value used for sorting: frontmatter keys fall back to the empty string. */
function sortValue(p: PageRec, key: string): string | number {
	switch (key) {
		case 'title':
			return p.title.toLowerCase();
		case 'path':
			return p.path.toLowerCase();
		case 'modified':
			return p.mtimeMs;
		case 'date':
			return dateOf(p);
		default:
			return p.frontmatter[key] == null ? '' : String(p.frontmatter[key]);
	}
}

const toRow = (p: PageRec): PagesRow => {
	const frontmatter: Record<string, string> = {};
	for (const [k, v] of Object.entries(p.frontmatter)) frontmatter[k] = v == null ? '' : String(v);
	return {
		path: p.path,
		title: p.title,
		folder: folderOf(p.path),
		tags: p.tags,
		date: dateOf(p),
		modified: new Date(p.mtimeMs).toISOString(),
		frontmatter
	};
};

/** Default columns per show mode; `columns` is only used for `show: table`. */
function resolveColumns(query: PagesQuery, show: PagesShow): string[] {
	if (show !== 'table') return [];
	if (query.columns?.length) return query.columns.map((c) => c.trim().toLowerCase());
	return ['title', 'date', 'tags'];
}

function cellValue(row: PagesRow, column: string): string {
	switch (column) {
		case 'title':
			return row.title;
		case 'folder':
			return row.folder;
		case 'tags':
			return row.tags.join(', ');
		case 'modified':
			return row.modified;
		case 'date':
			return row.date;
		case 'path':
			return row.path;
		default:
			return row.frontmatter[column] ?? '';
	}
}

/**
 * Runs a validated query against the in-memory index. `self` is the page the block lives on,
 * used to resolve `this` in `folder` and `links-to`.
 *
 * `opts.candidates` restricts the universe (the `kb.*` presets only look at the pages of a
 * category); `opts.exclude` drops one page (a widget never lists the page it lives on).
 */
export function runPagesQuery(
	index: SpaceIndex,
	query: PagesQuery,
	self = '',
	opts: { candidates?: PageRec[]; exclude?: string } = {}
): PagesResult {
	const show = query.show ?? 'list';
	const limit = query.limit ?? DEFAULT_LIMIT;
	const wanted = query.tag == null ? [] : Array.isArray(query.tag) ? query.tag : [query.tag];

	const folderFilter = query.folder === 'this' ? folderOf(self) : query.folder;
	const linksTo = query['links-to'] === 'this' ? self : query['links-to'];

	let pages = (opts.candidates ?? index.list()).filter((p) => !p.hidden);

	if (wanted.length) pages = pages.filter((p) => tagMatches(p.tags, wanted));
	if (folderFilter) {
		const f = folderFilter.replace(/\/+$/, '').toLowerCase();
		pages = pages.filter((p) => folderOf(p.path).toLowerCase() === f || p.path.toLowerCase().startsWith(f + '/'));
	}
	if (linksTo) {
		const target = index.resolve(linksTo, self) ?? linksTo;
		const sources = new Set(index.backlinks(target).map((b) => b.path));
		pages = pages.filter((p) => sources.has(p.path));
	}
	if (opts.exclude) pages = pages.filter((p) => p.path !== opts.exclude);

	const { key, dir } = parseSort(query.sort);
	const sign = dir === 'asc' ? 1 : -1;
	pages.sort((a, b) => {
		const va = sortValue(a, key);
		const vb = sortValue(b, key);
		if (va < vb) return -1 * sign;
		if (va > vb) return 1 * sign;
		return a.path.localeCompare(b.path);
	});

	const total = pages.length;
	const rows = show === 'count' ? [] : pages.slice(0, limit).map(toRow);
	return { query, show, columns: resolveColumns(query, show), rows, total };
}

const e = (s: string) => MarkdownIt().utils.escapeHtml(s);
const href = (path: string) => '/' + encodeURI(path);

/**
 * Escaped HTML for a query result. Every value comes from the index and is escaped here,
 * the same way the other widgets build their markup. Page titles link to their page.
 */
export function renderPagesResult(result: PagesResult): string {
	const { show, total } = result;
	if (show === 'count') {
		return `<div class="wg wg-query wg-count"><strong>${total}</strong> ${total === 1 ? 'page' : 'pages'}</div>`;
	}
	if (total === 0) return `<div class="wg wg-query"><p class="muted">No page matches this query.</p></div>`;
	if (show === 'table') {
		const cols = result.columns;
		const head = cols.map((c) => `<th>${e(c)}</th>`).join('');
		const body = result.rows
			.map(
				(row) =>
					'<tr>' +
					cols
						.map((c, i) => {
							const raw = cellValue(row, c);
							if (i === 0) return `<th scope="row">${link(row.path, raw || row.path)}</th>`;
							return `<td>${e(raw)}</td>`;
						})
						.join('') +
					'</tr>'
			)
			.join('');
		const more = total > result.rows.length ? `<p class="muted">Showing ${result.rows.length} of ${total}.</p>` : '';
		return `<div class="wg wg-query wg-table"><div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${more}</div>`;
	}
	// list
	const items = result.rows
		.map((row) => {
			const date = row.date || (row.modified ? row.modified.slice(0, 10) : '');
			return `<li>${link(row.path, row.title)}${date ? `<span class="wg-date">${e(date)}</span>` : ''}</li>`;
		})
		.join('');
	return `<div class="wg wg-query wg-list"><ul>${items}</ul></div>`;
}

function link(path: string, label: string): string {
	return `<a class="wikilink" href="${href(path)}">${e(label)}</a>`;
}

/** Error markup for an invalid block: the message plus the block source, never a blank. */
export function renderPagesError(message: string, source: string): string {
	return (
		`<div class="wg-query-error" role="alert"><strong>Invalid pages block: ${e(message)}</strong>` +
		`<pre><code>${e(source)}</code></pre></div>`
	);
}
