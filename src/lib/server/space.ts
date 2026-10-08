import { fuzzyScore } from '../fuzzy';
import { analyze, type WikiLink } from './markdown';
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

export interface SearchHit {
	path: string;
	title: string;
	/** folder of the page ("" for root pages) */
	folder: string;
	tags: string[];
	/** best matching section: heading text and anchor, empty for the page intro */
	section: { heading: string; slug: string };
	snippet: string;
	/** lower-cased query terms, for highlighting */
	terms: string[];
	score: number;
}

export interface SearchResult {
	query: string;
	terms: string[];
	filters: { tags: string[]; folders: string[] };
	total: number;
	results: SearchHit[];
	facets: { folders: { name: string; count: number }[]; tags: { name: string; count: number }[] };
}

/** Splits a query into terms ("quoted phrases" stay together) and `#tag` / `in:folder` filters. */
export function parseQuery(q: string): { terms: string[]; tags: string[]; folders: string[] } {
	const terms: string[] = [];
	const tags: string[] = [];
	const folders: string[] = [];
	for (const m of q.matchAll(/"([^"]+)"|(\S+)/g)) {
		const raw = (m[1] ?? m[2]).toLowerCase();
		if (m[2] && raw.startsWith('#') && raw.length > 1) tags.push(raw.slice(1));
		else if (m[2] && raw.startsWith('in:') && raw.length > 3) folders.push(raw.slice(3).replace(/\/+$/, ''));
		else terms.push(raw);
	}
	return { terms, tags, folders };
}

const HIDDEN_PREFIX = 'Library/';

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
	private configTags = new Map<string, string>();
	private timer: NodeJS.Timeout | null = null;
	private polling = false;

	constructor(readonly store: Store) {}

	async init(): Promise<void> {
		await this.refresh();
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
					changed = true;
				}
			}
			for (let i = 0; i < todo.length; i += 16) {
				await Promise.all(todo.slice(i, i + 16).map((f) => this.load(f)));
			}
			if (todo.length) changed = true;
			if (changed) this.rebuild(true);
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
			title: path.slice(path.lastIndexOf('/') + 1),
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
		this.rebuild(isNew);
	}

	applyDelete(page: string): void {
		if (page === 'CONFIG') this.configTags = new Map();
		if (this.pages.delete(page)) this.rebuild(true);
	}

	private rebuild(setChanged: boolean): void {
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
			.map(([path, count]) => ({ path, title: path.slice(path.lastIndexOf('/') + 1), count }))
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
		const { terms, tags, folders } = parseQuery(query);
		const empty: SearchResult = { query, terms, filters: { tags, folders }, total: 0, results: [], facets: { folders: [], tags: [] } };
		if (!terms.length && !tags.length && !folders.length) return empty;
		const hits: (SearchHit & { mtimeMs: number })[] = [];
		for (const p of this.pages.values()) {
			if (p.hidden && !includeHidden) continue;
			const lowPath = p.path.toLowerCase();
			if (folders.length && !folders.every((f) => lowPath.startsWith(f + '/'))) continue;
			if (tags.length && !tags.every((t) => p.tags.some((x) => x === t || x.startsWith(t + '/')))) continue;
			const lowTitle = p.title.toLowerCase();
			const lowTags = p.tags.join(' ');
			let score = 0;
			let ok = true;
			for (const term of terms) {
				const inTitle = lowTitle.includes(term);
				const inPath = lowPath.includes(term);
				const inTags = lowTags.includes(term);
				if (!inTitle && !inPath && !inTags && !p.textLower.includes(term)) {
					ok = false;
					break;
				}
				if (inTitle) score += lowTitle.startsWith(term) ? 45 : /(^|[\s/_-])/.test(lowTitle) && new RegExp(`(^|[\\s/_-])${escapeRe(term)}`).test(lowTitle) ? 32 : 18;
				else if (inPath) score += 8;
				if (inTags) score += 12;
			}
			if (!ok) continue;
			// best section: most distinct terms, then most occurrences; heading hits count extra
			let best = { heading: '', slug: '', text: '', lower: '' };
			let bestScore = -1;
			for (const sec of p.sections) {
				const head = sec.heading.toLowerCase();
				let sc = 0;
				let distinct = 0;
				for (const term of terms) {
					let n = 0;
					for (let i = sec.lower.indexOf(term); i >= 0 && n < 6; i = sec.lower.indexOf(term, i + term.length)) n++;
					if (n) distinct++;
					sc += Math.log2(1 + n) * 3;
					if (head.includes(term)) sc += 10;
				}
				sc += distinct * 6;
				if (sc > bestScore) ((bestScore = sc), (best = sec));
			}
			score += Math.max(bestScore, 0);
			hits.push({
				path: p.path,
				title: p.title,
				folder: p.path.includes('/') ? p.path.slice(0, p.path.lastIndexOf('/')) : '',
				tags: p.tags.slice(0, 5),
				section: { heading: best.heading, slug: best.slug },
				snippet: terms.length ? snippet(best.text || p.text, best.lower || p.textLower, terms) : p.text.slice(0, 160).replace(/\s+/g, ' ').trim(),
				terms,
				score,
				mtimeMs: p.mtimeMs
			});
		}
		// typo tolerance: nothing matched literally, fall back to fuzzy title/path matching
		if (!hits.length && terms.length) {
			const needle = terms.join(' ');
			for (const p of this.pages.values()) {
				if (p.hidden && !includeHidden) continue;
				const sc = Math.max(fuzzyScore(needle, p.title), fuzzyScore(needle, p.path));
				if (sc < 0) continue;
				hits.push({ path: p.path, title: p.title, folder: p.path.includes('/') ? p.path.slice(0, p.path.lastIndexOf('/')) : '', tags: p.tags.slice(0, 5), section: { heading: '', slug: '' }, snippet: '', terms, score: sc, mtimeMs: p.mtimeMs });
			}
		}
		hits.sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs);
		const folderCounts = new Map<string, number>();
		const tagCounts = new Map<string, number>();
		for (const h of hits) {
			const top = h.path.includes('/') ? h.path.slice(0, h.path.indexOf('/')) : '';
			folderCounts.set(top, (folderCounts.get(top) ?? 0) + 1);
			for (const t of h.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
		}
		const top = (m: Map<string, number>, n: number) =>
			[...m.entries()].filter(([k]) => k).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([name, count]) => ({ name, count }));
		return {
			...empty,
			total: hits.length,
			results: hits.slice(0, limit).map(({ mtimeMs: _m, ...h }) => h),
			facets: { folders: top(folderCounts, 8), tags: top(tagCounts, 10) }
		};
	}
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function snippet(text: string, lower: string, terms: string[]): string {
	let at = -1;
	for (const t of terms) {
		const i = lower.indexOf(t);
		if (i >= 0 && (at < 0 || i < at)) at = i;
	}
	if (at < 0) return text.slice(0, 140).replace(/\s+/g, ' ').trim();
	const from = Math.max(0, at - 70);
	const to = Math.min(text.length, at + 110);
	return (from > 0 ? '…' : '') + text.slice(from, to).replace(/\s+/g, ' ').trim() + (to < text.length ? '…' : '');
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
