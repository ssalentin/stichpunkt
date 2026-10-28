import { checkPage, folderOwner, MANIFEST_PAGE, manifestInstructions, parseDateValue, parseManifest, sameActor, type ManifestIssue, type ManifestRules, type PageWarning } from './agent-manifest';
import { loadConfig, type MdwikiConfig } from './config';
import { MdwikiError } from './errors';
import { escapeHtml, parseFrontmatter, slugify, renderBody, sectionOf, type EmbedRef, type ExprSource, type PagesBlock, type Rendered, type Widget } from './markdown';
import { renderWidget } from './widgets';
import { parsePagesBlock, parsePagesQuery, renderPagesError, renderPagesResult, runPagesQuery, PagesQueryError } from './pages-query';
import { evaluateNode, parseExpr, QueryBudget, MAX_EXPRS_PER_PAGE, ExprRuntimeError, ExprParseError, type EvalContext } from './expr';
import { renderValue } from './expr-render';
import { valueToJson, valueToText } from './expr-render';
import { isImageTarget, lineAt, PathResolver, rewriteLinksForMove, scanLinks } from './links';
import { assertAllowedExtension, fileToPage, normalizeRel, pageToFile } from './paths';
import { SpaceIndex, type PageRec } from './space';
import { hashOf, Store, type FileInfo } from './store';
import { listActivity, listRevisions, moveHistory, readRevision, recordRevision as writeRevision, type ActorSource, type Revision, type RevisionTool } from './history';
import { changeStats, unifiedDiff } from './diff';

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

const MAX_EMBED_DEPTH = 3;
const MAX_EMBEDS_PER_PAGE = 20;
const MAX_EMBED_CHARS = 200_000;

interface EmbedCtx {
	depth: number;
	/** pages currently being embedded, outermost first (loop guard) */
	stack: string[];
	docId: string;
	/** shared by every level of one host page */
	shared: { count: number; usedClient: Set<string> };
}

export class Mdwiki {
	readonly store: Store;
	readonly index: SpaceIndex;
	private htmlCache = new Map<string, CacheEntry>();
	/** last valid manifest (kept when the file later turns invalid) */
	private manifest: { rules: ManifestRules; prose: string; hash: string } | null = null;
	/** issues of the MANIFEST.md currently on disk, when it is invalid */
	private manifestInvalid: { hash: string; issues: ManifestIssue[] } | null = null;

	constructor(readonly config: MdwikiConfig = loadConfig()) {
		this.store = new Store(config.spaceDir, {
			maxWriteBytes: config.maxWriteBytes,
			maxUploadBytes: config.maxUploadBytes
		});
		this.index = new SpaceIndex(this.store);
		this.index.onChange = () => this.reloadManifest();
	}

	async start(poll = true): Promise<this> {
		await this.index.init();
		await this.reloadManifest();
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

	// ---- agent manifest --------------------------------------------------------------------

	/** Re-reads MANIFEST.md from disk (start, poll). A valid file replaces the active manifest; an invalid one is logged and ignored. */
	private async reloadManifest(): Promise<void> {
		const file = await this.store.read(pageToFile(MANIFEST_PAGE));
		if (!file) {
			this.manifest = null;
			this.manifestInvalid = null;
			return;
		}
		const hash = hashOf(file.data);
		if (hash === this.manifest?.hash || hash === this.manifestInvalid?.hash) return;
		this.adoptManifest(file.data.toString('utf8'), hash);
	}

	private adoptManifest(raw: string, hash: string): void {
		const res = parseManifest(raw);
		if (res.ok) {
			this.manifest = { ...res.value, hash };
			this.manifestInvalid = null;
		} else {
			this.manifestInvalid = { hash, issues: res.issues };
			console.error(`[mdwiki] MANIFEST.md is invalid, ${this.manifest ? 'keeping the last valid manifest' : 'no manifest active'}:`, JSON.stringify(res.issues));
		}
	}

	/** Rules for the MCP `initialize` response; null without a valid manifest. */
	manifestInstructions(): string | null {
		return this.manifest ? manifestInstructions(this.manifest.rules) : null;
	}

	getManifest() {
		if (!this.manifest) {
			if (this.manifestInvalid) {
				throw new MdwikiError(422, 'manifest_invalid', 'MANIFEST.md is invalid and no earlier valid version is active', { issues: this.manifestInvalid.issues });
			}
			return { exists: false as const };
		}
		return {
			exists: true as const,
			path: MANIFEST_PAGE,
			hash: this.manifest.hash,
			rules: this.manifest.rules,
			prose: this.manifest.prose,
			...(this.manifestInvalid ? { invalid_on_disk: { issues: this.manifestInvalid.issues } } : {})
		};
	}

	/**
	 * Validates MANIFEST.md against the current schema and the space: strict key/enum errors,
	 * `allowed_tags` without a matching `tag.define` in CONFIG, folders without any page, and
	 * folder keys that collide after path normalisation. Read-only.
	 */
	async checkManifest(): Promise<{ ok: boolean; issues: { path: string; message: string }[] }> {
		const file = await this.store.read(pageToFile(MANIFEST_PAGE));
		if (!file) return { ok: true, issues: [] };
		const parsed = parseManifest(file.data.toString('utf8'));
		if (!parsed.ok) {
			return {
				ok: false,
				issues: parsed.issues.map((issue) => ({ path: issue.path.map(String).join('.') || '(root)', message: issue.message }))
			};
		}
		const rules = parsed.value.rules;
		const issues: { path: string; message: string }[] = [];
		const pages = [...this.index.pages.keys()].map((page) => page.toLowerCase());
		const folders = new Map<string, string>();
		for (const key of Object.keys(rules.folders ?? {})) {
			const normalized = key.trim().replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/').toLowerCase();
			if (!normalized) {
				issues.push({ path: `folders.${key}`, message: 'Folder name is empty' });
				continue;
			}
			const clash = folders.get(normalized);
			if (clash !== undefined) {
				issues.push({ path: `folders.${key}`, message: `Folder collides with "${clash}" after path normalisation` });
			} else {
				folders.set(normalized, key);
			}
			// a folder exists when it has pages below it or its own root page (Folder.md)
			if (!pages.some((page) => page === normalized || page.startsWith(normalized + '/'))) {
				issues.push({ path: `folders.${key}`, message: `Folder "${key}" has no page` });
			}
		}
		const definedTags = new Set(this.index.categories().map((category) => category.tag.toLowerCase()));
		for (const tag of rules.pages?.allowed_tags ?? []) {
			const normalized = tag.trim().replace(/^#/, '').toLowerCase();
			if (!normalized) issues.push({ path: 'pages.allowed_tags', message: 'Tag is empty' });
			else if (!definedTags.has(normalized)) {
				issues.push({ path: 'pages.allowed_tags', message: `Tag "#${normalized}" has no tag.define in CONFIG` });
			}
		}
		return { ok: issues.length === 0, issues };
	}

	/** Same warnings as a write would return, without writing. */
	validatePage(page: unknown, content: unknown, agent?: string): { warnings: PageWarning[] } {
		if (typeof page !== 'string') throw new MdwikiError(400, 'bad_path', '"path" must be a string');
		if (typeof content !== 'string') throw new MdwikiError(400, 'bad_content', '"content" must be a string');
		return { warnings: this.warningsFor(this.pageName(page), content, undefined, agent) };
	}

	private actorInfo(page: string, agent?: string) {
		const owner = folderOwner(this.manifest?.rules ?? null, page) ?? null;
		const actor = agent?.trim() || null;
		return { actor, owner, owner_ok: sameActor(agent, owner ?? undefined) };
	}

	private warningsFor(page: string, content: string, resolver?: PathResolver, agent?: string): PageWarning[] {
		const warnings = checkPage(this.manifest?.rules ?? null, page, content, { agent });
		if (this.manifest?.rules.checks?.includes('links')) {
			const resolve = resolver ?? new PathResolver(this.index.pages.keys());
			for (const link of scanLinks(content)) {
				if (!link.target || (link.embed && isImageTarget(link.target))) continue;
				if (resolve.resolve(link.target, page)) continue;
				warnings.push({ rule: 'dead_link', message: `Link target "${link.target}" does not exist`, line: lineAt(content, link.start) });
			}
		}
		return warnings;
	}

	/** Rejects an invalid MANIFEST before it reaches the disk. */
	private assertManifestValid(page: string, content: string): void {
		if (page !== MANIFEST_PAGE) return;
		const res = parseManifest(content);
		if (!res.ok) throw new MdwikiError(400, 'manifest_invalid', 'MANIFEST is invalid; the file was not changed', { issues: res.issues });
	}

	// ---- writes --------------------------------------------------------------------------

	/** `baseHash`: undefined = overwrite blindly, "" = page must not exist, else must match. */
	async writePage(page: string, content: unknown, baseHash?: string | null, agent?: string, note?: string) {
		if (typeof content !== 'string') throw new MdwikiError(400, 'bad_content', '"content" must be a string');
		const rel = pageToFile(page);
		const name = fileToPage(rel);
		const data = Buffer.from(content, 'utf8');
		return this.store.withLock(rel, async () => {
			const cur = await this.store.read(rel);
			if (baseHash !== undefined && baseHash !== null) {
				const curHash = cur ? hashOf(cur.data) : null;
				const ok = baseHash === '' ? cur === null : curHash === baseHash;
				if (!ok) throw conflict(cur);
			}
			this.assertManifestValid(name, content);
			const warnings = this.warningsFor(name, content, undefined, agent);
			if (cur) await this.recordRevision(name, cur.data, { tool: 'write_page', agent, note, next: content, warnings: warnings.map((w) => w.rule) });
			const info = await this.store.write(rel, data, 'page');
			this.index.applyWrite(name, content, info);
			if (name === MANIFEST_PAGE) this.adoptManifest(content, hashOf(data));
			return { path: name, hash: hashOf(data), created: cur === null, warnings, ...this.actorInfo(name, agent) };
		});
	}

	async appendToPage(page: string, text: unknown, agent?: string, note?: string) {
		if (typeof text !== 'string' || text === '') {
			throw new MdwikiError(400, 'bad_content', '"content" must be a non-empty string');
		}
		const rel = pageToFile(page);
		const name = fileToPage(rel);
		return this.store.withLock(rel, async () => {
			const cur = await this.store.read(rel);
			const old = cur ? cur.data.toString('utf8') : '';
			const sep = old && !old.endsWith('\n') ? '\n' : '';
			const next = old + sep + text + (text.endsWith('\n') ? '' : '\n');
			const data = Buffer.from(next, 'utf8');
			this.assertManifestValid(name, next);
			const warnings = this.warningsFor(name, next, undefined, agent);
			if (cur) await this.recordRevision(name, cur.data, { tool: 'append_to_page', agent, note, next, warnings: warnings.map((w) => w.rule) });
			const info = await this.store.write(rel, data, 'page');
			this.index.applyWrite(name, next, info);
			if (name === MANIFEST_PAGE) this.adoptManifest(next, hashOf(data));
			return { path: name, hash: hashOf(data), created: cur === null, warnings, ...this.actorInfo(name, agent) };
		});
	}

	async deletePage(page: string, agent?: string, note?: string) {
		const rel = pageToFile(page);
		return this.store.withLock(rel, async () => {
			const cur = await this.store.read(rel);
			if (cur) {
				await this.recordRevision(fileToPage(rel), cur.data, { tool: 'delete_page', agent, note, marker: 'deleted', next: '', warnings: [] });
			}
			const removed = await this.store.remove(rel);
			if (!removed) throw new MdwikiError(404, 'not_found', `Page "${fileToPage(rel)}" does not exist`);
			this.index.applyDelete(fileToPage(rel));
			if (fileToPage(rel) === MANIFEST_PAGE) {
				this.manifest = null;
				this.manifestInvalid = null;
			}
			return { path: fileToPage(rel), deleted: true };
		});
	}

	// ---- page operations -----------------------------------------------------------------

	/**
	 * Moves a page and rewrites only those links that would stop resolving to it. Links that
	 * keep working (a unique basename, a relative target inside the folder) stay untouched;
	 * the move itself runs as one transaction with the rewritten backlinks.
	 */
	async movePage(fromInput: unknown, toInput: unknown, dryRun = false, agent?: string, overwrite = false, note?: string) {
		if (typeof fromInput !== 'string' || typeof toInput !== 'string') {
			throw new MdwikiError(400, 'bad_path', '"from" and "to" must be strings');
		}
		const from = fileToPage(pageToFile(fromInput));
		const to = fileToPage(pageToFile(toInput));
		if (from === to) throw new MdwikiError(400, 'bad_path', '"from" and "to" are the same page');
		const fromRel = pageToFile(from);
		const toRel = pageToFile(to);
		const rels = [...this.index.pages.keys()].map(pageToFile);
		return this.store.withLocks([...rels, fromRel, toRel], async () => {
			const source = await this.store.read(fromRel);
			if (!source) throw new MdwikiError(404, 'not_found', `Page "${from}" does not exist`);
			const target = await this.store.read(toRel);
			if (target && !overwrite) throw new MdwikiError(409, 'target_exists', `Page "${to}" already exists`);
			const raw = source.data.toString('utf8');
			const pages: { path: string; content: string }[] = [];
			for (const path of new Set([...this.index.pages.keys(), from])) {
				// an overwritten target is replaced wholesale, so its old links do not matter
				if (target && path === to) continue;
				const file = path === from ? source : await this.store.read(pageToFile(path));
				if (file) pages.push({ path, content: file.data.toString('utf8') });
			}
			const plan = rewriteLinksForMove(pages, from, to);
			const movedContent = plan.rewritten.find((r) => r.path === to)?.content ?? raw;
			const after = new PathResolver([...this.index.pages.keys()].filter((p) => p !== from).concat(to));
			const warnings = this.warningsFor(to, movedContent, after, agent);
			const result = {
				from,
				to,
				dry_run: dryRun,
				moved: !dryRun,
				hash: hashOf(movedContent),
				...(target ? { overwrite: true, previous_hash: hashOf(target.data) } : {}),
				rewritten: plan.rewritten.map(({ path, links }) => ({ path, links })),
				unresolved: plan.unresolved,
				warnings
			};
			if (dryRun) return result;
			const rewritten = new Map(plan.rewritten.map((r) => [r.path, r.content]));
			const ruleNames = warnings.map((w) => w.rule);
			const writes = [{ path: to, content: movedContent }, ...plan.rewritten.filter((r) => r.path !== to)];
			const journal: { rel: string; prev: Buffer | null }[] = [];
			try {
				for (const write of writes) {
					const rel = pageToFile(write.path);
					const cur = await this.store.read(rel);
					journal.push({ rel, prev: cur ? cur.data : null });
					await this.store.write(rel, Buffer.from(write.content, 'utf8'), 'page');
				}
				journal.push({ rel: fromRel, prev: source.data });
				if (!(await this.store.remove(fromRel))) throw new Error('the source page disappeared during the move');
			} catch {
				const rolledBack = await this.rollback(journal);
				throw new MdwikiError(500, 'write_failed', `Moving "${from}" to "${to}" failed`, { rolled_back: rolledBack, path: to });
			}
			const changes: { path: string; content: string; info: FileInfo }[] = [];
			for (const write of writes) {
				const info = await this.store.stat(pageToFile(write.path));
				if (info) changes.push({ path: write.path, content: write.content, info });
			}
			this.index.applyBatch(changes, [from]);
			if (from === MANIFEST_PAGE || to === MANIFEST_PAGE) await this.reloadManifest();
			// Revisions only after every file write succeeded, so a rolled-back move leaves no
			// history behind. The overwrite record comes first so moveHistory offsets after it.
			if (target) {
				await this.recordRevision(to, target.data, {
					tool: 'move_page',
					agent,
					note,
					marker: `overwritten by move from ${from}`,
					next: movedContent,
					warnings: ruleNames
				});
			}
			// the page keeps its history: no restart at version 1 on the new path
			await moveHistory(this.store, from, to);
			await this.recordRevision(to, source.data, {
				tool: 'move_page',
				agent,
				note,
				marker: `moved from ${from}`,
				next: movedContent,
				warnings: ruleNames
			});
			for (const page of pages) {
				if (page.path === from || page.path === to) continue;
				const nextContent = rewritten.get(page.path);
				if (nextContent === undefined) continue;
				await this.recordRevision(page.path, Buffer.from(page.content, 'utf8'), {
					tool: 'move_page',
					agent,
					note,
					next: nextContent,
					warnings: this.warningsFor(page.path, nextContent, after, agent).map((w) => w.rule)
				});
			}
			return result;
		});
	}

	/**
	 * Writes several pages as one transaction: all locks in sorted order, every base hash
	 * checked before the first write, one index rebuild. A conflict changes nothing; an
	 * unexpected disk error rolls the already written files back.
	 */
	async writePages(input: unknown, dryRun = false, agent?: string, note?: string) {
		if (!Array.isArray(input)) throw new MdwikiError(400, 'bad_request', '"pages" must be an array');
		const entries = input.map((raw, i) => this.batchEntry(raw, i));
		const seen = new Set<string>();
		for (const entry of entries) {
			if (seen.has(entry.path)) throw new MdwikiError(400, 'duplicate_path', `Page "${entry.path}" appears more than once in the batch`);
			seen.add(entry.path);
			if (Buffer.byteLength(entry.content, 'utf8') > this.config.maxWriteBytes) {
				throw new MdwikiError(413, 'too_large', `The content of "${entry.path}" exceeds the limit of ${this.config.maxWriteBytes} bytes`);
			}
		}
		const rels = entries.map((e) => pageToFile(e.path));
		return this.store.withLocks(rels, async () => {
			const conflicts: { path: string; expected: string; actual: string | null }[] = [];
			const previous = new Map<string, Buffer | null>();
			for (const entry of entries) {
				const file = await this.store.read(pageToFile(entry.path));
				previous.set(entry.path, file ? file.data : null);
				if (entry.baseHash === undefined) continue;
				const actual = file ? hashOf(file.data) : null;
				const matches = entry.baseHash === '' ? file === null : actual === entry.baseHash;
				if (!matches) conflicts.push({ path: entry.path, expected: entry.baseHash, actual });
			}
			if (conflicts.length) {
				throw new MdwikiError(409, 'conflict', 'One or more pages changed since they were read', { conflicts });
			}
			for (const entry of entries) this.assertManifestValid(entry.path, entry.content);
			const resolver = new PathResolver([...this.index.pages.keys(), ...entries.map((e) => e.path)]);
			const written = entries.map((entry) => ({
				path: entry.path,
				hash: hashOf(entry.content),
				warnings: this.warningsFor(entry.path, entry.content, resolver, agent),
				...this.actorInfo(entry.path, agent)
			}));
			if (dryRun) return { dry_run: true, written };
			for (const entry of entries) {
				const previousData = previous.get(entry.path);
				if (!previousData) continue;
				const record = written.find((w) => w.path === entry.path);
				await this.recordRevision(entry.path, previousData, {
					tool: 'write_page',
					agent,
					note,
					next: entry.content,
					warnings: record?.warnings.map((w) => w.rule) ?? []
				});
			}
			const journal: { rel: string; prev: Buffer | null }[] = [];
			for (const entry of entries) {
				const rel = pageToFile(entry.path);
				journal.push({ rel, prev: previous.get(entry.path) ?? null });
				try {
					await this.store.write(rel, Buffer.from(entry.content, 'utf8'), 'page');
				} catch {
					const rolledBack = await this.rollback(journal);
					throw new MdwikiError(500, 'write_failed', `Writing "${entry.path}" failed`, { rolled_back: rolledBack, path: entry.path });
				}
			}
			const changes: { path: string; content: string; info: FileInfo }[] = [];
			for (const entry of entries) {
				const info = await this.store.stat(pageToFile(entry.path));
				if (info) changes.push({ path: entry.path, content: entry.content, info });
			}
			this.index.applyBatch(changes, []);
			const manifest = entries.find((e) => e.path === MANIFEST_PAGE);
			if (manifest) this.adoptManifest(manifest.content, hashOf(manifest.content));
			return { dry_run: false, written };
		});
	}

	/** Reads-only link audit: dead and ambiguous targets, anchors, orphans. */
	async checkLinks(path?: unknown, includeHidden = false) {
		let scope = '';
		if (path !== undefined && path !== null && path !== '') {
			if (typeof path !== 'string') throw new MdwikiError(400, 'bad_path', '"path" must be a string');
			scope = fileToPage(pageToFile(path));
		}
		const all = [...this.index.pages.values()];
		const resolver = new PathResolver(all.map((p) => p.path));
		const files = await Promise.all(
			all.map(async (page) => ({
				page,
				raw: (await this.store.read(pageToFile(page.path)))?.data.toString('utf8') ?? ''
			}))
		);
		const visible = (p: { path: string; hidden: boolean }) =>
			(includeHidden || !p.hidden) && (!scope || p.path === scope || p.path.startsWith(scope + '/'));
		const dead: { path: string; line: number; target: string }[] = [];
		const ambiguous: { path: string; target: string; candidates: string[] }[] = [];
		const anchors: { path: string; target: string; heading: string }[] = [];
		let linkCount = 0;
		const inbound = new Map<string, Set<string>>();
		for (const { page, raw } of files) {
			if (!visible(page)) continue;
			for (const link of scanLinks(raw)) {
				if (!link.target || (link.embed && isImageTarget(link.target))) continue;
				linkCount++;
				const resolved = resolver.resolve(link.target, page.path);
				const line = lineAt(raw, link.start);
				if (!resolved) {
					dead.push({ path: page.path, line, target: link.target });
					const candidates = resolver.basenames(link.target);
					if (candidates.length >= 2) ambiguous.push({ path: page.path, target: link.target, candidates });
					continue;
				}
				if (link.heading) {
					const target = this.index.get(resolved);
					const slug = slugify(link.heading);
					if (target && !target.headings.some((h) => h.slug === slug)) {
						anchors.push({ path: page.path, target: link.target, heading: link.heading });
					}
				}
			}
		}
		// links from outside the scope still count as incoming, otherwise a folder looks orphaned
		const inboundScope = (p: { path: string; hidden: boolean }) => includeHidden || !p.hidden;
		for (const { page, raw } of files) {
			if (!inboundScope(page)) continue;
			for (const link of scanLinks(raw)) {
				if (!link.target || (link.embed && isImageTarget(link.target))) continue;
				const resolved = resolver.resolve(link.target, page.path);
				if (!resolved || resolved === page.path) continue;
				let from = inbound.get(resolved);
				if (!from) inbound.set(resolved, (from = new Set()));
				from.add(page.path);
			}
		}
		const orphans = files
			.map((f) => f.page)
			.filter((p) => visible(p) && (inbound.get(p.path)?.size ?? 0) === 0)
			.map((p) => ({ path: p.path, root: !p.path.includes('/') }));
		const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);
		return {
			dead: dead.sort(byPath),
			ambiguous: ambiguous.sort(byPath),
			orphans: orphans.sort(byPath),
			anchors: anchors.sort(byPath),
			counts: {
				pages: files.filter((f) => visible(f.page)).length,
				links: linkCount,
				dead: dead.length,
				ambiguous: ambiguous.length,
				orphans: orphans.length,
				anchors: anchors.length
			}
		};
	}

	/** Revisions of a page, newest first. Read-only. */
	async history(page: unknown, limit = 50) {
		const path = this.historyPage(page);
		const revisions = await listRevisions(this.store, path);
		return { path, total: revisions.length, revisions: revisions.slice(0, clamp(limit, 1, 500)).map((r) => this.withActorName(r)) };
	}

	/** Revisions across all pages, newest first, filterable by time, actor, folder and page. */
	async activity(since?: unknown, actor?: unknown, folder?: unknown, page?: unknown, limit = 50) {
		const sinceDate = this.optionalDate(since, 'since');
		const actorSlug = this.optionalText(actor, 'actor');
		const pagePath = this.optionalPage(page, 'page');
		const folderPath = this.optionalPage(folder, 'folder');
		const result = await listActivity(this.store, {
			since: sinceDate,
			actor: actorSlug,
			folder: folderPath,
			page: pagePath,
			limit: clamp(limit, 1, 500)
		});
		return { total: result.total, records: result.records.map((r) => ({ ...this.withActorName(r), path: r.path })) };
	}

	private withActorName<T extends Revision>(revision: T): T & { actor_name: string } {
		const name = this.manifest?.rules.actors?.[revision.actor]?.name;
		return { ...revision, actor_name: name ?? revision.actor };
	}

	private optionalText(value: unknown, field: string): string | undefined {
		if (value === undefined || value === null || value === '') return undefined;
		if (typeof value !== 'string') throw new MdwikiError(400, 'bad_query', `"${field}" must be a string`);
		return value.trim();
	}

	private optionalPage(value: unknown, field: string): string | undefined {
		const text = this.optionalText(value, field);
		return text === undefined ? undefined : fileToPage(pageToFile(text));
	}

	private optionalDate(value: unknown, field: string): Date | undefined {
		const text = this.optionalText(value, field);
		if (text === undefined) return undefined;
		const date = parseDateValue(text);
		if (!date) throw new MdwikiError(400, 'bad_query', `"${field}" must be a date`);
		return date;
	}

	/** Unified diff between one revision (hash or ISO time, default: the last one) and the page now. */
	async diff(page: unknown, since?: unknown) {
		const path = this.historyPage(page);
		const revisions = await listRevisions(this.store, path);
		if (!revisions.length) throw new MdwikiError(404, 'no_history', `Page "${path}" has no revisions yet`);
		const revision = pickRevision(revisions, since);
		if (!revision) throw new MdwikiError(404, 'revision_not_found', 'No revision matches "since"');
		const saved = await readRevision(this.store, path, revision.id);
		if (!saved) throw new MdwikiError(404, 'revision_not_found', `Revision "${revision.id}" is not readable`);
		const current = await this.store.read(pageToFile(path));
		const result = unifiedDiff(saved.content, current ? current.data.toString('utf8') : '', `${path} @ ${revision.id}`, `${path} (current)`);
		return {
			path,
			since: this.withActorName(revision),
			current: { exists: current !== null, hash: current ? hashOf(current.data) : null },
			diff: result.diff,
			added: result.added,
			removed: result.removed,
			truncated: result.truncated
		};
	}

	private historyPage(page: unknown): string {
		if (typeof page !== 'string') throw new MdwikiError(400, 'bad_path', '"path" must be a string');
		return fileToPage(pageToFile(page));
	}

	private async recordRevision(
		page: string,
		data: Buffer,
		opts: { tool: RevisionTool; agent?: string; note?: string; marker?: string; next?: string; warnings?: string[] }
	): Promise<void> {
		const oldText = data.toString('utf8');
		const stats = changeStats(oldText, opts.next ?? oldText);
		const actor = opts.agent?.trim();
		await writeRevision(this.store, page, data, {
			keep: this.config.historyKeep,
			actor: actor || 'unknown',
			actorSource: (actor ? 'field' : 'unknown') as ActorSource,
			tool: opts.tool,
			bytesAdded: stats.bytesAdded,
			bytesRemoved: stats.bytesRemoved,
			warnings: opts.warnings ?? [],
			note: opts.note ? opts.note.slice(0, 500) : undefined,
			marker: opts.marker
		});
	}

	private batchEntry(raw: unknown, index: number): { path: string; content: string; baseHash: string | undefined } {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
			throw new MdwikiError(400, 'bad_request', `pages[${index}] must be an object`);
		}
		const entry = raw as Record<string, unknown>;
		if (typeof entry.path !== 'string') throw new MdwikiError(400, 'bad_path', `pages[${index}].path must be a string`);
		if (typeof entry.content !== 'string') throw new MdwikiError(400, 'bad_content', `pages[${index}].content must be a string`);
		if (entry.base_hash !== undefined && entry.base_hash !== null && typeof entry.base_hash !== 'string') {
			throw new MdwikiError(400, 'bad_base_hash', `pages[${index}].base_hash must be a string`);
		}
		return {
			path: fileToPage(pageToFile(entry.path)),
			content: entry.content,
			baseHash: (entry.base_hash ?? undefined) as string | undefined
		};
	}

	/** Restores the journal in reverse order; returns false when at least one restore failed. */
	private async rollback(journal: { rel: string; prev: Buffer | null }[]): Promise<boolean> {
		let ok = true;
		for (const step of [...journal].reverse()) {
			try {
				if (step.prev === null) await this.store.remove(step.rel);
				else await this.store.write(step.rel, step.prev, 'page');
			} catch {
				ok = false;
			}
		}
		return ok;
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
		const dynamic = (e: CacheEntry) => e.rendered.widgets.length > 0 || e.rendered.pagesBlocks.length > 0 || e.rendered.exprs.length > 0 || e.rendered.embeds.length > 0;
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
			const embedded = await this.fillEmbeds(withExprs, rendered.embeds, name, { depth: 0, stack: [name], docId: '', shared: { count: 0, usedClient: new Set() } });
			const html = embedded.html;
			const done = { ...rendered, html, usedClient: [...new Set([...rendered.usedClient, ...embedded.usedClient])] };
			const dynamic = rendered.widgets.length > 0 || rendered.pagesBlocks.length > 0 || rendered.exprs.length > 0 || rendered.embeds.length > 0;
			entry = {
				hash: hashOf(file.data),
				setVersion: this.index.setVersion,
				version: dynamic ? this.index.version : 0,
				day: rendered.exprs.some((x) => x.usesToday) ? day : '',
				rendered: done
			};
			this.htmlCache.set(name, entry);
			if (this.htmlCache.size > 500) this.htmlCache.delete(this.htmlCache.keys().next().value!);
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

	/**
	 * Replaces every `<!--embed:n-->` placeholder with the embedded page (or section). An embed
	 * alone in its paragraph becomes a block; inside running text it degrades to a plain link.
	 * Embedded pages are rendered with the full pipeline, but their headings lose their ids (the
	 * outline and anchors belong to the host page) and their footnote ids get a unique suffix.
	 */
	private async fillEmbeds(html: string, embeds: EmbedRef[], self: string, ctx: EmbedCtx): Promise<{ html: string; usedClient: Set<string> }> {
		if (!embeds.length) return { html, usedClient: ctx.shared.usedClient };
		const out = await Promise.all(embeds.map((e, i) => this.renderEmbed(e, i, self, ctx)));
		const inline = (id: string) => {
			const e = embeds[Number(id)];
			const to = this.index.resolve(e.target, self);
			const label = escapeHtml(to ? this.index.displayName(to) : e.target);
			return to ? `<a class="wikilink" href="/${encodeURI(to)}">${label}</a>` : `<span class="wikilink missing">${label}</span>`;
		};
		const filled = html
			.replace(/<p><!--embed:(\d+)--><\/p>/g, (_m, id) => out[Number(id)]?.block ?? '')
			.replace(/<!--embed:(\d+)-->/g, (_m, id) => inline(id));
		return { html: filled, usedClient: ctx.shared.usedClient };
	}

	private async renderEmbed(e: EmbedRef, index: number, self: string, ctx: EmbedCtx): Promise<{ block: string }> {
		const note = (cls: string, msg: string) => ({ block: `<div class="embed embed-${cls}" role="note">${escapeHtml(msg)}</div>\n` });
		const to = this.index.resolve(e.target, self);
		if (!to) return note('missing', `Embedded page “${e.target}” does not exist`);
		if (ctx.stack.includes(to)) return note('loop', `Embedding “${to}” here would loop; skipped`);
		if (ctx.depth >= MAX_EMBED_DEPTH) return note('limit', `Embeds are nested too deeply (limit ${MAX_EMBED_DEPTH}); “${to}” skipped`);
		if (++ctx.shared.count > MAX_EMBEDS_PER_PAGE) return note('limit', `Too many embeds on this page (limit ${MAX_EMBEDS_PER_PAGE})`);
		const file = await this.store.read(pageToFile(to));
		if (!file) return note('missing', `Embedded page “${to}” does not exist`);
		const fm = parseFrontmatter(file.data.toString('utf8'));
		let body = fm.body;
		if (e.heading) {
			const part = sectionOf(body, e.heading);
			if (part === null) return note('missing', `“${to}” has no heading “${e.heading}”`);
			body = part;
		}
		if (body.length > MAX_EMBED_CHARS) body = body.slice(0, MAX_EMBED_CHARS);
		const docId = `${ctx.docId}e${index}`;
		const dir = to.includes('/') ? to.slice(0, to.lastIndexOf('/')) : '';
		const rendered = renderBody(body, { dir, docId, resolve: (t) => this.index.resolve(t, to), label: (p) => this.index.displayName(p) });
		const budget = new QueryBudget();
		let inner = this.fillWidgets(rendered.html, rendered.widgets, to);
		inner = this.fillPagesBlocks(inner, rendered.pagesBlocks, to, budget);
		inner = this.fillExpressions(inner, rendered.exprs, to, budget);
		const nested = await this.fillEmbeds(inner, rendered.embeds, to, { ...ctx, depth: ctx.depth + 1, stack: [...ctx.stack, to], docId });
		for (const c of rendered.usedClient) ctx.shared.usedClient.add(c);
		const content = nested.html.replace(/(<h[1-6]) id="[^"]*"/g, '$1');
		const frag = e.heading ? '#' + slugify(e.heading) : '';
		const label = (this.index.get(to)?.title ?? to) + (e.heading ? ` › ${e.heading}` : '');
		return {
			block:
				`<aside class="embed" data-embed="${escapeHtml(to)}"><div class="embed-head"><a class="wikilink" href="/${encodeURI(to)}${frag}" title="${escapeHtml(to)}">${escapeHtml(label)}</a></div>` +
				`<div class="embed-body">${content}</div></aside>\n`
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
		// a block result (a page list) replaces its whole paragraph, like a widget; inline stays inside
		const isBlock = (h: string) => /^<(ul|ol|div|table)[\s>]/.test(h);
		return html
			.replace(/<p><!--expr:(\d+)--><\/p>/g, (_m, id) => {
				const h = out[Number(id)] ?? '';
				return isBlock(h) ? h : `<p>${h}</p>`;
			})
			.replace(/<!--expr:(\d+)-->/g, (_m, id) => out[Number(id)] ?? '');
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

/** A revision by id, hash prefix, or the newest revision at or before an ISO/date value. */
function pickRevision(revisions: Revision[], since?: unknown): Revision | null {
	if (!revisions.length) return null;
	if (since === undefined || since === null || since === '') return revisions[0];
	if (typeof since !== 'string') return null;
	const needle = since.trim();
	for (const revision of revisions) {
		if (revision.id === needle || revision.hash === needle || revision.id.startsWith(needle) || revision.hash.startsWith(needle)) return revision;
	}
	const at = parseDateValue(needle);
	if (!at) return null;
	return revisions.find((revision) => new Date(revision.at).getTime() <= at.getTime()) ?? null;
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
