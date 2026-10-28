import { fuzzyScore } from '../fuzzy';
import { analyze, type WikiLink } from './markdown';
import { buildIndex, fuzzyFallback, parseQuery, runSearch, type SearchHit, type SearchIndex, type SearchResult } from './search';

export { parseQuery };
export type { SearchHit, SearchResult };
import { fileToPage, pageToFile } from './paths';
import { hashOf, type FileInfo, type Store } from './store';

export interface PageRec {
	path: string;
	title: string;
	mtimeMs: number;
	size: number;
	hash: string;
	hidden: boolean;
	frontmatter: Record<string, unknown>;
	tags: string[];
	links: WikiLink[];
	headings: { level: number; text: string; slug: string }[];
	text: string;
	textLower: string;
	sections: { heading: string; slug: string; text: string; lower: string }[];
}

const HIDDEN_PREFIX = 'Library/';

/**
 * Display title of a page: the frontmatter `title`, else the first H1 heading,
 * else the filename stub. Keeps navigation readable without editing any file.
 */
export function pageTitle(path: string, frontmatter: Record<string, unknown>, headings: { level: number; text: string }[]): string {
	const fm = frontmatter.title ?? frontmatter.name;
	if (typeof fm === 'string' && fm.trim()) return fm.trim();
	const h1 = headings.find((h) => h.level === 1 && h.text.trim());
	if (h1) return h1.text.trim();
	return path.slice(path.lastIndexOf('/') + 1);
}

/** What `SpaceIndex.subscribe` listeners receive after the set of pages or their content changed. */
export interface SpaceChange {
	/** the index version after the change */
	version: number;
	/** pages that were added, edited or removed (not the pages whose rendering merely depends on them) */
	paths: string[];
}

/** In-memory index over the files: titles, frontmatter, tags, links, backlinks, headings, full text. */
export class SpaceIndex {
	pages = new Map<string, PageRec>();
	/** bumped whenever the set of pages changes (link resolution depends on it) */
	setVersion = 0;
	/** bumped on every change */
	version = 0;
	private lower = new Map<string, string>();
	private byBase = new Map<string, string[]>();
	private backlinkMap = new Map<string, Map<string, number>>();
	private tagMap = new Map<string, Set<string>>();
	private tagPageMap = new Map<string, string>();
	private searchIndex: SearchIndex | null = null;
	private configTags = new Map<string, string>();
	private timer: NodeJS.Timeout | null = null;
	private polling = false;
	/** called after a refresh that changed something (the service reloads the agent manifest) */
	onChange: (() => Promise<void> | void) | null = null;
	private listeners = new Set<(change: SpaceChange) => void>();

	constructor(readonly store: Store) {}

	async init(): Promise<void> {
		await this.refresh();
	}

	/** Calls `fn` after every change (an API write or a file edit found by the poll). Returns the unsubscribe function. */
	subscribe(fn: (change: SpaceChange) => void): () => void {
		this.listeners.add(fn);
		return () => void this.listeners.delete(fn);
	}

	startPolling(intervalMs: number): void {
		this.stopPolling();
		this.timer = setInterval(() => {
			this.refresh().catch((e) => console.error('[mdwiki] poll failed:', e));
		}, intervalMs);
		this.timer.unref();
	}

	stopPolling(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	/** Compares the directory with the index and reparses new/changed/removed files. */
	async refresh(): Promise<boolean> {
		if (this.polling) return false;
		this.polling = true;
		try {
			const files = await this.store.scan();
			const seen = new Set<string>();
			let changed = false;
			const touched: string[] = [];
			const todo: FileInfo[] = [];
			for (const f of files) {
				const page = fileToPage(f.rel);
				seen.add(page);
				const cur = this.pages.get(page);
				if (!cur || cur.mtimeMs !== f.mtimeMs || cur.size !== f.size) todo.push(f);
			}
			for (const page of [...this.pages.keys()]) {
				if (!seen.has(page)) {
					this.pages.delete(page);
					if (page === 'CONFIG') this.configTags = new Map();
					touched.push(page);
					changed = true;
				}
			}
			for (let i = 0; i < todo.length; i += 16) {
				await Promise.all(todo.slice(i, i + 16).map((f) => this.load(f)));
			}
			if (todo.length) changed = true;
			for (const f of todo) touched.push(fileToPage(f.rel));
			if (changed) this.rebuild(true, touched);
			if (changed) await this.onChange?.();
			return changed;
		} finally {
			this.polling = false;
		}
	}

	private async load(info: FileInfo): Promise<void> {
		const file = await this.store.read(info.rel);
		if (!file) return;
		this.ingest(info.rel, file.data.toString('utf8'), file.info);
	}

	private ingest(rel: string, content: string, info: FileInfo): void {
		const path = fileToPage(rel);
		const a = analyze(content);
		if (path === 'CONFIG') this.configTags = parseTagPages(content);
		this.pages.set(path, {
			path,
			title: pageTitle(path, a.frontmatter, a.headings),
			mtimeMs: info.mtimeMs,
			size: info.size,
			hash: hashOf(content),
			hidden: path.startsWith(HIDDEN_PREFIX),
			frontmatter: a.frontmatter,
			tags: a.tags,
			links: a.links,
			headings: a.headings,
			text: a.text,
			textLower: a.text.toLowerCase(),
			sections: a.sections.map((x) => ({ ...x, lower: x.text.toLowerCase() }))
		});
	}

	/** Called after the app itself wrote a page. */
	applyWrite(page: string, content: string, info: FileInfo): void {
		const isNew = !this.pages.has(page);
		this.ingest(pageToFile(page), content, info);
		this.rebuild(isNew, [page]);
	}

	applyDelete(page: string): void {
		if (page === 'CONFIG') this.configTags = new Map();
		if (this.pages.delete(page)) this.rebuild(true, [page]);
	}

	private rebuild(setChanged: boolean, paths: string[] = []): void {
		this.version++;
		if (setChanged) this.setVersion++;
		this.lower.clear();
		this.byBase.clear();
		for (const p of this.pages.keys()) {
			this.lower.set(p.toLowerCase(), p);
			const base = p.slice(p.lastIndexOf('/') + 1).toLowerCase();
			const list = this.byBase.get(base);
			if (list) list.push(p);
			else this.byBase.set(base, [p]);
		}
		this.backlinkMap = new Map();
		this.tagMap = new Map();
		for (const rec of this.pages.values()) {
			for (const t of rec.tags) {
				let set = this.tagMap.get(t);
				if (!set) this.tagMap.set(t, (set = new Set()));
				set.add(rec.path);
			}
			for (const l of rec.links) {
				const target = l.target ? this.resolve(l.target, rec.path) : rec.path;
				if (!target || target === rec.path) continue;
				let m = this.backlinkMap.get(target);
				if (!m) this.backlinkMap.set(target, (m = new Map()));
				m.set(rec.path, (m.get(rec.path) ?? 0) + 1);
			}
		}
		this.tagPageMap = this.configTags;
		this.searchIndex = buildIndex(
			[...this.pages.values()].map((p) => ({
				path: p.path,
				title: p.title,
				tags: p.tags,
				headings: p.headings,
				sections: p.sections,
				text: p.text,
				mtimeMs: p.mtimeMs,
				hidden: p.hidden
			}))
		);
		const change: SpaceChange = { version: this.version, paths };
		for (const fn of this.listeners) {
			try {
				fn(change);
			} catch (e) {
				console.error('[mdwiki] change listener failed:', e);
			}
		}
	}

	/** Exact path, then case-insensitive, then relative to the page's folder, then unique basename. */
	resolve(target: string, from: string): string | null {
		const t = target.replace(/^\/+/, '').replace(/\.md$/i, '');
		if (this.pages.has(t)) return t;
		const lo = t.toLowerCase();
		const direct = this.lower.get(lo);
		if (direct) return direct;
		const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
		if (dir) {
			const rel = this.lower.get(`${dir}/${lo}`.toLowerCase());
			if (rel) return rel;
		}
		if (!t.includes('/')) {
			const cands = this.byBase.get(lo);
			if (cands?.length === 1) return cands[0];
		}
		return null;
	}

	/**
	 * Human label for a wikilink that targets `path`: the page name (last segment).
	 * Only when several pages share that name is the shortest distinguishing folder
	 * prefix added, so a unique `Konventionen/Sprache` reads as `Sprache` while
	 * `Server/personal01` and `Privat/personal01` keep their folder.
	 */
	displayName(path: string): string {
		const base = path.slice(path.lastIndexOf('/') + 1);
		const cands = this.byBase.get(base.toLowerCase());
		if (!cands || cands.length < 2) return base;
		const segments = path.split('/');
		for (let keep = 2; keep <= segments.length; keep++) {
			const suffix = '/' + segments.slice(segments.length - keep).join('/').toLowerCase();
			if (cands.every((c) => c === path || !c.toLowerCase().endsWith(suffix))) return segments.slice(segments.length - keep).join('/');
		}
		return path;
	}

	get(page: string): PageRec | undefined {
		return this.pages.get(page);
	}

	list(prefix = '', includeHidden = false): PageRec[] {
		const showHidden = includeHidden || prefix.startsWith(HIDDEN_PREFIX) || prefix === 'Library';
		const norm = prefix.replace(/^\/+/, '');
		return [...this.pages.values()]
			.filter((p) => (showHidden || !p.hidden) && p.path.startsWith(norm))
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	recent(n: number): PageRec[] {
		return [...this.pages.values()]
			.filter((p) => !p.hidden)
			.sort((a, b) => b.mtimeMs - a.mtimeMs)
			.slice(0, n);
	}

	backlinks(page: string): { path: string; title: string; count: number }[] {
		const m = this.backlinkMap.get(page);
		if (!m) return [];
		return [...m.entries()]
			.map(([path, count]) => ({ path, title: this.pages.get(path)?.title ?? path.slice(path.lastIndexOf('/') + 1), count }))
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	tags(): { name: string; count: number }[] {
		return [...this.tagMap.entries()]
			.map(([name, set]) => ({ name, count: [...set].filter((p) => !this.pages.get(p)?.hidden).length }))
			.filter((t) => t.count > 0)
			.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
	}

	pagesByTag(tag: string): PageRec[] {
		const set = this.tagMap.get(tag.replace(/^#/, '').toLowerCase());
		if (!set) return [];
		return [...set]
			.map((p) => this.pages.get(p)!)
			.filter((p) => p && !p.hidden)
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	/** Tags that should be listed at the bottom of `page` ("Pages tagged #x"). */
	tagsForPage(page: string): string[] {
		const base = page.slice(page.lastIndexOf('/') + 1).toLowerCase();
		const out = new Set<string>();
		for (const [tag, target] of this.tagPageMap) {
			if (target.toLowerCase() === page.toLowerCase()) out.add(tag);
		}
		if (this.tagMap.has(base)) out.add(base);
		return [...out];
	}

	/** Categories from the `tag.define` entries in CONFIG, in CONFIG order. */
	categories(): { tag: string; label: string; page: string; count: number; hue: number }[] {
		return [...this.tagPageMap.entries()].map(([tag, page]) => ({
			tag,
			label: page,
			page,
			count: this.noteTagged(tag).length,
			hue: hueOf(tag)
		}));
	}

	/** Notes carrying `tag`, not counting hidden pages or the category's own start page. */
	noteTagged(tag: string): PageRec[] {
		const page = this.tagPageMap.get(tag)?.toLowerCase();
		return this.pagesByTag(tag).filter((p) => p.path.toLowerCase() !== page);
	}

	tagPageFor(tag: string): string | undefined {
		return this.tagPageMap.get(tag);
	}

	search(query: string, limit = 30, includeHidden = false): SearchResult {
		if (!this.searchIndex) this.searchIndex = buildIndex([]);
		return runSearch(this.searchIndex, query, { limit, includeHidden, fuzzy: fuzzyFallback(fuzzyScore) });
	}
}

/**
 * Reads `tag.define { name = "x", tagPage = "Y" }` mappings from CONFIG.md. The Lua is never
 * executed; only these two string fields are extracted.
 */
export function parseTagPages(raw: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const block of raw.matchAll(/tag\.define\s*\{([^}]*)\}/g)) {
		const name = /\bname\s*=\s*"([^"]+)"/.exec(block[1])?.[1];
		const page = /\btagPage\s*=\s*"([^"]+)"/.exec(block[1])?.[1];
		if (name && page) out.set(name.toLowerCase(), page);
	}
	return out;
}

export const HUES = 8;

/** Stable palette slot (0..7) for a tag. */
export function hueOf(tag: string): number {
	let h = 0;
	for (const ch of tag) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
	return h % HUES;
}
