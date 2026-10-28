/**
 * Wikilink scanning with source offsets.
 *
 * `renderBody` only reports the link targets it saw, without positions, and it skips
 * anything inside code. This module mirrors those recognition rules on the raw text and
 * keeps the byte offsets, so page operations can rewrite exactly the link syntax a
 * reader sees and nothing inside a fence or an inline code span.
 */

import { parseFrontmatter } from './markdown';

export interface ScannedLink {
	/** offset of the opening `!` (embed) or `[` */
	start: number;
	/** offset just after the closing `]]` */
	end: number;
	/** offset of the first character of the target text (the `.md` suffix excluded) */
	targetStart: number;
	/** offset just after the target text */
	targetEnd: number;
	/** `![[...]]` */
	embed: boolean;
	/** target without `.md`, trimmed */
	target: string;
	heading?: string;
	alias?: string;
}

const IMAGE = /\.(png|jpe?g|gif|svg|webp|avif)$/i;

/** Attachments referenced by `![[picture.png]]` are not page links. */
export function isImageTarget(target: string): boolean {
	return IMAGE.test(target);
}

/**
 * Every wikilink in `raw` outside frontmatter, fenced code blocks and inline code spans.
 * The syntax rules follow the `wikilink`/`embed` inline rules in markdown.ts.
 */
export function scanLinks(raw: string): ScannedLink[] {
	const fm = parseFrontmatter(raw);
	const offset = raw.length - fm.body.length;
	const body = fm.body;
	const out: ScannedLink[] = [];
	let i = 0;
	while (i < body.length) {
		const ch = body[i];
		if (ch === '\\') {
			i += 2;
			continue;
		}
		// a fenced code block starts at the beginning of a line (up to three spaces)
		if (ch === '`' || ch === '~') {
			const lineStart = body.lastIndexOf('\n', i - 1) + 1;
			const before = body.slice(lineStart, i);
			const run = runLength(body, i, ch);
			const info = body.slice(i + run, lineEnd(body, i));
			const fence = /^ {0,3}$/.test(before) && run >= 3 && (ch === '~' || !info.includes('`'));
			if (fence) {
				const close = findFenceClose(body, lineEnd(body, i), ch, run);
				if (close >= 0) {
					i = close;
					continue;
				}
			}
			if (ch === '`') {
				const close = findCodeClose(body, i + run, ch, run);
				i = close >= 0 ? close + run : i + run;
			} else {
				i += run;
			}
			continue;
		}
		const embed = ch === '!' && body[i + 1] === '[' && body[i + 2] === '[';
		const open = embed ? i + 1 : i;
		if (body[open] === '[' && body[open + 1] === '[') {
			const end = body.indexOf(']]', open + 2);
			if (end >= 0) {
				const inner = body.slice(open + 2, end);
				if (!inner.includes('\n') && !inner.includes('[') && inner.trim() !== '') {
					const link = parseInner(inner, open + 2, embed, offset);
					if (link) out.push(link);
					i = end + 2;
					continue;
				}
			}
		}
		i++;
	}
	return out;
}

function parseInner(inner: string, innerStart: number, embed: boolean, baseOffset: number): ScannedLink | null {
	const pipe = inner.indexOf('|');
	const targetPart = pipe < 0 ? inner : inner.slice(0, pipe);
	const alias = pipe < 0 ? undefined : inner.slice(pipe + 1).trim() || undefined;
	let heading: string | undefined;
	let rawTarget = targetPart;
	const hashAt = targetPart.indexOf('#');
	if (hashAt >= 0) {
		heading = targetPart.slice(hashAt + 1).trim() || undefined;
		rawTarget = targetPart.slice(0, hashAt);
	}
	const target = rawTarget.trim().replace(/\.md$/i, '');
	if (!target && !heading) return null;
	const leading = rawTarget.length - rawTarget.trimStart().length;
	const targetStart = innerStart + leading;
	const targetEnd = targetStart + target.length;
	return {
		start: baseOffset + (embed ? innerStart - 3 : innerStart - 2),
		end: baseOffset + innerStart + inner.length + 2,
		targetStart: baseOffset + targetStart,
		targetEnd: baseOffset + targetEnd,
		embed,
		target,
		heading,
		alias
	};
}

function runLength(s: string, at: number, ch: string): number {
	let n = 0;
	while (s[at + n] === ch) n++;
	return n;
}

function lineEnd(s: string, at: number): number {
	const nl = s.indexOf('\n', at);
	return nl < 0 ? s.length : nl;
}

/** Offset of the closing fence, or -1 when the block runs to the end of the document. */
function findFenceClose(s: string, from: number, ch: string, len: number): number {
	let pos = from;
	while (pos < s.length) {
		const end = lineEnd(s, pos);
		const line = s.slice(pos, end);
		const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
		if (m && m[1][0] === ch && m[1].length >= len) return end;
		pos = end + 1;
	}
	return -1;
}

function findCodeClose(s: string, from: number, ch: string, len: number): number {
	let pos = from;
	while (pos < s.length) {
		if (s[pos] === ch) {
			const run = runLength(s, pos, ch);
			if (run === len) return pos;
			pos += run;
			continue;
		}
		pos++;
	}
	return -1;
}

/** Line number (1-based) of an absolute offset. */
export function lineAt(raw: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < raw.length; i++) if (raw.charCodeAt(i) === 10) line++;
	return line;
}

/**
 * The page resolution rules of `SpaceIndex.resolve`, over an explicit path set so a move
 * can be simulated without touching the index.
 */
export class PathResolver {
	private readonly paths: Set<string>;
	private readonly lower = new Map<string, string>();
	private readonly byBase = new Map<string, string[]>();

	constructor(paths: Iterable<string>) {
		this.paths = new Set(paths);
		for (const p of this.paths) {
			this.lower.set(p.toLowerCase(), p);
			const base = p.slice(p.lastIndexOf('/') + 1).toLowerCase();
			const list = this.byBase.get(base);
			if (list) list.push(p);
			else this.byBase.set(base, [p]);
		}
	}

	basenames(target: string): string[] {
		const t = target.replace(/^\/+/, '').replace(/\.md$/i, '');
		if (t.includes('/')) return [];
		return this.byBase.get(t.toLowerCase()) ?? [];
	}

	resolve(target: string, from: string): string | null {
		const t = target.replace(/^\/+/, '').replace(/\.md$/i, '');
		if (this.paths.has(t)) return t;
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
}

export interface RewriteInput {
	/** current path of the page */
	path: string;
	content: string;
}

export interface RewriteOutput {
	/** path after the move (the moved page reports its new path) */
	path: string;
	content: string;
	/** number of rewritten links */
	links: number;
}

export interface UnresolvedLink {
	path: string;
	target: string;
	reason: 'ambiguous_basename' | 'unresolvable';
}

export interface MoveRewrite {
	rewritten: RewriteOutput[];
	unresolved: UnresolvedLink[];
}

/**
 * Rewrites the links that pointed at `from` and would stop pointing at `to` after the move.
 * A link that still resolves to the new page keeps its text, including unique-basename and
 * heading-only forms. `![[...]]`, `#Heading` and `|alias` survive unchanged.
 */
export function rewriteLinksForMove(pages: RewriteInput[], from: string, to: string): MoveRewrite {
	const before = new PathResolver(pages.map((p) => p.path));
	const after = new PathResolver(pages.map((p) => (p.path === from ? to : p.path)));
	const rewritten: RewriteOutput[] = [];
	const unresolved: UnresolvedLink[] = [];
	for (const page of pages) {
		const afterPath = page.path === from ? to : page.path;
		const links = scanLinks(page.content).filter((l) => l.target !== '' && !(l.embed && isImageTarget(l.target)));
		const edits: { start: number; end: number; text: string }[] = [];
		for (const link of links) {
			const was = before.resolve(link.target, page.path);
			if (was !== from) {
				// a bare basename that is ambiguous but names the moved page is worth reporting
				if (was === null && !link.target.includes('/') && before.basenames(link.target).includes(from)) {
					unresolved.push({ path: afterPath, target: link.target, reason: 'ambiguous_basename' });
				}
				continue;
			}
			if (after.resolve(link.target, afterPath) === to) continue;
			let next = link.target.includes('/') ? to : to.slice(to.lastIndexOf('/') + 1);
			if (after.resolve(next, afterPath) !== to) next = to;
			if (after.resolve(next, afterPath) !== to) {
				unresolved.push({ path: afterPath, target: link.target, reason: 'unresolvable' });
				continue;
			}
			edits.push({ start: link.targetStart, end: link.targetEnd, text: next });
		}
		if (!edits.length) continue;
		let content = page.content;
		for (const edit of edits.sort((a, b) => b.start - a.start)) {
			content = content.slice(0, edit.start) + edit.text + content.slice(edit.end);
		}
		rewritten.push({ path: afterPath, content, links: edits.length });
	}
	return { rewritten, unresolved };
}
