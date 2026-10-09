import { loadConfig, type MdwikiConfig } from './config';
import { MdwikiError } from './errors';
import { KrokiClient } from './kroki';
import { escapeHtml, parseFrontmatter, renderBody, type ExprSource, type KrokiJob, type PagesBlock, type Rendered, type Widget } from './markdown';
import { renderWidget } from './widgets';
import { parsePagesBlock, parsePagesQuery, renderPagesError, renderPagesResult, runPagesQuery, PagesQueryError } from './pages-query';
import { evaluateNode, parseExpr, QueryBudget, MAX_EXPRS_PER_PAGE, ExprRuntimeError, ExprParseError, type EvalContext } from './expr';
import { renderValue } from './expr-render';
import { valueToJson, valueToText } from './expr-render';
import { assertAllowedExtension, fileToPage, normalizeRel, pageToFile } from './paths';
import { SpaceIndex, type PageRec } from './space';
import { hashOf, Store } from './store';

export interface PageView {
	path: string;
	title: string;
	html: string;
	headings: Rendered['headings'];
	frontmatter: Record<string, unknown>;
	tags: string[];
	hash: string;
	mtimeMs: number;
	usedClient: string[];
	backlinks: { path: string; title: string; count: number }[];
	tagLists: { tag: string; pages: { path: string; title: string }[] }[];
}

export interface TreeNode {
	/** display label: the page title, or the folder name for a folder */
	name: string;
	/** filename stub (kept for sorting and folder identity) */
	stub: string;
	path: string;
	page: boolean;
	children: TreeNode[];
}

interface CacheEntry {
	hash: string;
	setVersion: number;
	/** index generation for pages with widgets/expressions (their output depends on other pages), else 0 */
	version: number;
	/** day key when the page uses `today()`, else '' */
	day: string;
	rendered: Rendered;
}

export class Mdwiki {
	readonly store: Store;
	readonly index: SpaceIndex;
	readonly kroki: KrokiClient;
	private htmlCache = new Map<string, CacheEntry>();

	constructor(readonly config: MdwikiConfig = loadConfig()) {
		this.store = new Store(config.spaceDir, {
			maxWriteBytes: config.maxWriteBytes,
			maxUploadBytes: config.maxUploadBytes
		});
		this.index = new SpaceIndex(this.store);
		this.kroki = new KrokiClient(config.krokiUrl, config.cacheDir);
	}

	async start(poll = true): Promise<this> {
		await this.index.init();
		if (poll) this.index.startPolling(this.config.pollInterval);
		return this;
	}

	stop(): void {
		this.index.stopPolling();
	}

	// ---- queries -------------------------------------------------------------------------

	search(query: string, limit = 30) {
		return this.index.search(String(query ?? ''), clamp(limit, 1, 200));
	}

	listPages(prefix = '') {
		return this.index.list(prefix).map(summary);
	}

	listTags() {
		return this.index.tags();
	}

	pagesByTag(tag: string) {
		return this.index.pagesByTag(tag).map(summary);
	}

	/**
	 * Runs the same declarative query engine as the `pages` block. Agents can try a query here
	 * (MCP `query_pages` / `POST /api/v1/query`) before writing it into a page.
	 */
	queryPages(query: unknown, self = '') {
		try {
			return runPagesQuery(this.index, parsePagesQuery(query), self);
		} catch (e) {
			if (e instanceof PagesQueryError) throw new MdwikiError(400, 'bad_query', e.message, { source: e.source });
			throw e;
		}
	}

	getBacklinks(page: string) {
		const name = this.pageName(page);
		return this.index.backlinks(this.index.resolve(name, '') ?? name);
	}

	/**
	 * Evaluates one expression against the index (MCP `evaluate` / `POST /api/v1/eval`). `page`
	 * sets `this`; an unknown page is a bad request. Parsing failures are 400s; runtime failures
	 * (unknown name, type error, a limit) are 400s too, because this is a diagnostic entry point.
	 */
	evaluateExpression(expr: unknown, page = '') {
		if (typeof expr !== 'string') throw new MdwikiError(400, 'bad_expr', '"expr" must be a string');
		const self = page ? this.pageName(page) : '';
		if (self && !this.index.get(self)) {
			throw new MdwikiError(404, 'not_found', `Page "${self}" does not exist`);
		}
		const ctx: EvalContext = { index: this.index, self, budget: new QueryBudget(), now: new Date() };
		try {
			const parsed = parseExpr(expr);
			const value = evaluateNode(parsed.node, ctx);
			return { value: valueToJson(value), text: valueToText(value) };
		} catch (e) {
			if (e instanceof ExprParseError) throw new MdwikiError(400, 'bad_expr', e.message);
			if (e instanceof ExprRuntimeError) throw new MdwikiError(400, 'expr_error', e.message);
			throw e;
		}
	}

	async readPage(page: string) {
		const rel = pageToFile(page);
		const file = await this.store.read(rel);
		if (!file) throw new MdwikiError(404, 'not_found', `Page "${fileToPage(rel)}" does not exist`);
		const content = file.data.toString('utf8');
		const fm = parseFrontmatter(content);
		return {
			path: fileToPage(rel),
			content,
			frontmatter: fm.data,
			hash: hashOf(file.data),
			mtime: new Date(file.info.mtimeMs).toISOString()
		};
	}

	// ---- writes --------------------------------------------------------------------------

	/** `baseHash`: undefined = overwrite blindly, "" = page must not exist, else must match. */
	async writePage(page: string, content: unknown, baseHash?: string | null) {
		if (typeof content !== 'string') throw new MdwikiError(400, 'bad_content', '"content" must be a string');
		const rel = pageToFile(page);
		const data = Buffer.from(content, 'utf8');
		return this.store.withLock(rel, async () => {
			const cur = await this.store.read(rel);
			if (baseHash !== undefined && baseHash !== null) {
				const curHash = cur ? hashOf(cur.data) : null;
				const ok = baseHash === '' ? cur === null : curHash === baseHash;
				if (!ok) throw conflict(cur);
			}
			const info = await this.store.write(rel, data, 'page');
			this.index.applyWrite(fileToPage(rel), content, info);
			return { path: fileToPage(rel), hash: hashOf(data), created: cur === null };
		});
	}

	async appendToPage(page: string, text: unknown) {
		if (typeof text !== 'string' || text === '') {
			throw new MdwikiError(400, 'bad_content', '"content" must be a non-empty string');
		}
		const rel = pageToFile(page);
		return this.store.withLock(rel, async () => {
			const cur = await this.store.read(rel);
			const old = cur ? cur.data.toString('utf8') : '';
			const sep = old && !old.endsWith('\n') ? '\n' : '';
			const next = old + sep + text + (text.endsWith('\n') ? '' : '\n');
			const data = Buffer.from(next, 'utf8');
			const info = await this.store.write(rel, data, 'page');
			this.index.applyWrite(fileToPage(rel), next, info);
			return { path: fileToPage(rel), hash: hashOf(data), created: cur === null };
		});
	}

	async deletePage(page: string) {
		const rel = pageToFile(page);
		return this.store.withLock(rel, async () => {
			const removed = await this.store.remove(rel);
			if (!removed) throw new MdwikiError(404, 'not_found', `Page "${fileToPage(rel)}" does not exist`);
			this.index.applyDelete(fileToPage(rel));
			return { path: fileToPage(rel), deleted: true };
		});
	}

	/** Stores any allowed file type (images, PDFs, ...). Markdown goes through the page path. */
	async uploadAttachment(relPath: string, bytes: Buffer) {
		const rel = normalizeRel(relPath);
		const ext = assertAllowedExtension(rel);
		if (ext === 'md') return this.writePage(rel, bytes.toString('utf8'));
		return this.store.withLock(rel, async () => {
			const info = await this.store.write(rel, bytes, 'upload');
			return { path: rel, size: info.size, hash: hashOf(bytes) };
		});
	}

	// ---- rendering ---------------------------------------------------------------------

	async renderPage(page: string): Promise<PageView | null> {
		const name = this.pageName(page);
		const rec = this.index.get(name);
		if (!rec) return null;
		let entry = this.htmlCache.get(name);
		const day = todayKey();
		const dynamic = (e: CacheEntry) => e.rendered.widgets.length > 0 || e.rendered.pagesBlocks.length > 0 || e.rendered.exprs.length > 0;
		if (
			!entry ||
			entry.hash !== rec.hash ||
			entry.setVersion !== this.index.setVersion ||
			(dynamic(entry) && entry.version !== this.index.version) ||
			(entry.day !== '' && entry.day !== day)
		) {
			const file = await this.store.read(pageToFile(name));
			if (!file) return null;
			const raw = file.data.toString('utf8');
			const fm = parseFrontmatter(raw);
			const dir = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '';
			const rendered = renderBody(fm.body, {
				dir,
				lineOffset: fm.lineOffset,
				resolve: (t) => this.index.resolve(t, name),
				label: (p) => this.index.displayName(p)
			});
			const withWidgets = this.fillWidgets(rendered.html, rendered.widgets, name);
			// one query budget per page, shared by `pages` blocks and expressions
			const budget = new QueryBudget();
			const withPages = this.fillPagesBlocks(withWidgets, rendered.pagesBlocks, name, budget);
			const withExprs = this.fillExpressions(withPages, rendered.exprs, name, budget);
			const { html, failed } = await this.fillDiagrams(withExprs, rendered.jobs);
			const done = { ...rendered, html };
			const dynamic = rendered.widgets.length > 0 || rendered.pagesBlocks.length > 0 || rendered.exprs.length > 0;
			entry = {
				hash: hashOf(file.data),
				setVersion: this.index.setVersion,
				version: dynamic ? this.index.version : 0,
				day: rendered.exprs.some((x) => x.usesToday) ? day : '',
				rendered: done
			};
			if (!failed) {
				this.htmlCache.set(name, entry);
				if (this.htmlCache.size > 500) this.htmlCache.delete(this.htmlCache.keys().next().value!);
			}
		}
		// a kb.recent widget already lists the tagged pages: do not append the automatic list as well
		const hasRecent = entry.rendered.widgets.some((w) => w.kind === 'recent');
		const tagLists = (hasRecent ? [] : this.index.tagsForPage(name)).map((tag) => ({
			tag,
			pages: this.index
				.pagesByTag(tag)
				.filter((p) => p.path !== name)
				.map((p) => ({ path: p.path, title: p.title }))
		}));
		return {
			path: name,
			title: rec.title,
			html: entry.rendered.html,
			headings: entry.rendered.headings,
			frontmatter: rec.frontmatter,
			tags: rec.tags,
			hash: entry.hash,
			mtimeMs: rec.mtimeMs,
			usedClient: entry.rendered.usedClient,
			backlinks: this.index.backlinks(name),
			tagLists
		};
	}

	private fillWidgets(html: string, widgets: Widget[], self: string): string {
		if (!widgets.length) return html;
		const out = widgets.map((w) => renderWidget(w, this.index, self));
		return html
			.replace(/<p><!--widget:(\d+)--><\/p>/g, (_m, id) => out[Number(id)] ?? '')
			.replace(/<!--widget:(\d+)-->/g, (_m, id) => out[Number(id)] ?? '');
	}

	/**
	 * Fills every `<!--pages:n-->` placeholder with the query result. An invalid block shows its
	 * error message and the block source instead of failing the whole page. All blocks share the
	 * page's query budget with the expressions.
	 */
	private fillPagesBlocks(html: string, blocks: PagesBlock[], self: string, budget: QueryBudget): string {
		if (!blocks.length) return html;
		const out = blocks.map((block) => {
			try {
				budget.take();
				return renderPagesResult(runPagesQuery(this.index, parsePagesBlock(block.source), self));
			} catch (e) {
				const message =
					e instanceof PagesQueryError || e instanceof ExprRuntimeError ? e.message : 'Could not run this query';
				return renderPagesError(message, block.source);
			}
		});
		return html
			.replace(/<p><!--pages:(\d+)--><\/p>/g, (_m, id) => out[Number(id)] ?? '')
			.replace(/<!--pages:(\d+)-->/g, (_m, id) => out[Number(id)] ?? '');
	}

	/**
	 * Fills every `<!--expr:n-->` placeholder with the rendered value of an expression. A runtime
	 * failure shows the red error chip with its message and the source text; it never blanks the
	 * page. All expressions share the page's query budget with the `pages` blocks.
	 */
	private fillExpressions(html: string, exprs: ExprSource[], self: string, budget: QueryBudget): string {
		if (!exprs.length) return html;
		const ctx: EvalContext = { index: this.index, self, budget, now: new Date() };
		const limited = `too many expressions on this page (limit ${MAX_EXPRS_PER_PAGE})`;
		// every placeholder gets a rendering; past the limit it is the red error chip
		const out = exprs.map((ex, i) => (i < MAX_EXPRS_PER_PAGE ? renderExpression(ex, ctx) : exprErrorChip(limited, ex.source)));
		// the placeholder is an inline token: replace it inside its paragraph first, then anywhere
		return html
			.replace(/<p><!--expr:(\d+)--><\/p>/g, (_m, id) => `<p>${out[Number(id)] ?? ''}</p>`)
			.replace(/<!--expr:(\d+)-->/g, (_m, id) => out[Number(id)] ?? '');
	}

	private async fillDiagrams(html: string, jobs: KrokiJob[]): Promise<{ html: string; failed: boolean }> {
		if (!jobs.length) return { html, failed: false };
		let failed = false;
		const out = await Promise.all(
			jobs.map(async (job) => {
				try {
					const key = await this.kroki.render(job.kroki, job.source);
					return `<figure class="diagram diagram-svg" data-diagram="${job.kroki}"><img src="/_ui/diagram/${key}" alt="${escapeHtml(job.label)} diagram" loading="lazy"></figure>\n`;
				} catch (e) {
					failed = true;
					return errorBlock(job.label, (e as Error).message, job.source);
				}
			})
		);
		return { html: html.replace(/<!--kroki:(\d+)-->\n?/g, (_m, id) => out[Number(id)] ?? ''), failed };
	}

	// ---- navigation data -------------------------------------------------------------------

	tree(): TreeNode[] {
		const root: TreeNode = { name: '', stub: '', path: '', page: false, children: [] };
		for (const p of this.index.list()) {
			let node = root;
			const parts = p.path.split('/');
			parts.forEach((part, i) => {
				const path = parts.slice(0, i + 1).join('/');
				let child = node.children.find((c) => c.stub === part);
				if (!child) node.children.push((child = { name: part, stub: part, path, page: false, children: [] }));
				if (i === parts.length - 1) {
					child.page = true;
					child.name = p.title;
				}
				node = child;
			});
		}
		const sort = (n: TreeNode) => {
			n.children.sort((a, b) => Number(!!b.children.length) - Number(!!a.children.length) || a.name.localeCompare(b.name));
			n.children.forEach(sort);
		};
		sort(root);
		return root.children;
	}

	recent(n = 8) {
		return this.index.recent(n).map(summary);
	}

	titles() {
		return this.index.list().map((p) => ({ path: p.path, title: p.title, mtimeMs: p.mtimeMs }));
	}

	namespace(prefix: string) {
		const pre = prefix.replace(/\/+$/, '') + '/';
		return this.index.list(pre).map(summary);
	}

	private pageName(page: string): string {
		return fileToPage(pageToFile(page));
	}
}

export function errorBlock(label: string, message: string, source: string): string {
	return (
		`<div class="diagram-error" role="alert"><strong>${escapeHtml(label)}: ${escapeHtml(message)}</strong>` +
		`<pre><code>${escapeHtml(source)}</code></pre></div>\n`
	);
}

/** Red error chip in the style of IS-181: the message and the source text, never blank. */
export function exprErrorChip(message: string, source: string): string {
	return (
		`<span class="chip error" role="alert"><strong>expression error: ${escapeHtml(message)}</strong>` +
		`<code>${escapeHtml(source)}</code></span>`
	);
}

const todayKey = (now = new Date()) => now.toISOString().slice(0, 10);

/** Renders one collected expression to inline HTML, degrading any failure to an error chip. */
function renderExpression(ex: ExprSource, ctx: EvalContext): string {
	if (!ex.placeholder) return `<span class="chip inert" title="${escapeHtml(ex.raw)}">expression · not run</span>`;
	try {
		const parsed = parseExpr(ex.source);
		const value = evaluateNode(parsed.node, ctx);
		return renderValue(value);
	} catch (e) {
		const message = e instanceof Error ? e.message : 'could not evaluate';
		return exprErrorChip(message, ex.source);
	}
}

function conflict(cur: { data: Buffer } | null): MdwikiError {
	return new MdwikiError(409, 'conflict', 'The page changed since you read it', {
		current: cur ? { content: cur.data.toString('utf8'), hash: hashOf(cur.data) } : null
	});
}

function summary(p: PageRec) {
	return { path: p.path, title: p.title, mtime: new Date(p.mtimeMs).toISOString(), size: p.size, tags: p.tags };
}

function clamp(n: number, lo: number, hi: number): number {
	const v = Number.isFinite(n) ? Math.trunc(n) : lo;
	return Math.min(hi, Math.max(lo, v));
}

// ---- process-wide singleton ------------------------------------------------------------

let instance: Promise<Mdwiki> | null = null;

export function getMdwiki(): Promise<Mdwiki> {
	instance ??= new Mdwiki().start().catch((e) => {
		instance = null;
		throw e;
	});
	return instance;
}
