import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import lua from 'highlight.js/lib/languages/lua';
import markdownLang from 'highlight.js/lib/languages/markdown';
import nginx from 'highlight.js/lib/languages/nginx';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yamlLang from 'highlight.js/lib/languages/yaml';
import * as yaml from 'js-yaml';
import MarkdownIt, { type Token } from 'markdown-it';
import { diagramForLang, INERT_FENCES } from '../diagrams';

const HLJS: Record<string, unknown> = {
	bash, sh: bash, shell: bash, css, diff, dockerfile, go, ini, toml: ini, java,
	javascript, js: javascript, json, lua, markdown: markdownLang, md: markdownLang,
	nginx, python, py: python, rust, sql, typescript, ts: typescript, xml, html: xml,
	yaml: yamlLang, yml: yamlLang
};
for (const [name, def] of Object.entries(HLJS)) {
	hljs.registerLanguage(name, def as never);
}

export interface Frontmatter {
	data: Record<string, unknown>;
	body: string;
	/** number of source lines taken by the frontmatter block */
	lineOffset: number;
	error?: string;
}

export function parseFrontmatter(raw: string): Frontmatter {
	const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
	if (!m) return { data: {}, body: raw, lineOffset: 0 };
	const lineOffset = m[0].split('\n').length - 1;
	const body = raw.slice(m[0].length);
	try {
		const parsed = yaml.load(m[1], { schema: yaml.CORE_SCHEMA });
		const data =
			parsed && typeof parsed === 'object' && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: {};
		return { data, body, lineOffset };
	} catch (e) {
		return { data: {}, body, lineOffset, error: (e as Error).message };
	}
}

export function frontmatterTags(data: Record<string, unknown>): string[] {
	const raw = data.tags ?? data.tag;
	let list: unknown[] = [];
	if (Array.isArray(raw)) list = raw;
	else if (typeof raw === 'string') list = raw.split(/[,\s]+/);
	return list
		.map((t) => String(t).trim().replace(/^#/, '').toLowerCase())
		.filter((t) => t.length > 0);
}

export function slugify(text: string): string {
	return (
		text
			.toLowerCase()
			.trim()
			.replace(/[^\p{L}\p{N}\s_-]/gu, '')
			.replace(/\s+/g, '-') || 'section'
	);
}

export interface WikiLink {
	/** target exactly as written (without heading) */
	target: string;
	heading?: string;
	alias?: string;
}

export interface KrokiJob {
	id: number;
	kroki: string;
	label: string;
	source: string;
}

export interface RenderEnv {
	[key: string]: unknown;
	/** resolves a wikilink target to an existing page path, or null */
	resolve?: (target: string) => string | null;
	/** directory of the current page, for relative URLs */
	dir?: string;
	lineOffset?: number;
	// collected during parse/render
	links?: WikiLink[];
	tags?: Set<string>;
	headings?: { level: number; text: string; slug: string }[];
	jobs?: KrokiJob[];
	usedClient?: Set<string>;
	slugs?: Map<string, number>;
}

const escapeHtml = (s: string) => MarkdownIt().utils.escapeHtml(s);

function wikilinkRule(state: any, silent: boolean): boolean {
	const src: string = state.src;
	const start = state.pos;
	if (src.charCodeAt(start) !== 0x5b || src.charCodeAt(start + 1) !== 0x5b) return false;
	const end = src.indexOf(']]', start + 2);
	if (end < 0) return false;
	const inner = src.slice(start + 2, end);
	if (inner.includes('\n') || inner.includes('[') || inner.trim() === '') return false;
	let [targetPart, alias] = splitFirst(inner, '|');
	let heading: string | undefined;
	const hashAt = targetPart.indexOf('#');
	if (hashAt >= 0) {
		heading = targetPart.slice(hashAt + 1).trim() || undefined;
		targetPart = targetPart.slice(0, hashAt);
	}
	const target = targetPart.trim().replace(/\.md$/i, '');
	if (!target && !heading) return false;
	if (!silent) {
		const tok = state.push('wikilink', '', 0);
		tok.meta = { target, heading, alias: alias?.trim() || undefined } satisfies WikiLink;
	}
	state.pos = end + 2;
	return true;
}

function splitFirst(s: string, ch: string): [string, string | undefined] {
	const i = s.indexOf(ch);
	return i < 0 ? [s, undefined] : [s.slice(0, i), s.slice(i + 1)];
}

const TAG_RE = /#([\p{L}_][\p{L}\p{N}_\-/]*)/uy;

function tagRule(state: any, silent: boolean): boolean {
	const start = state.pos;
	if (state.src.charCodeAt(start) !== 0x23) return false;
	if (start > 0) {
		const prev = state.src[start - 1];
		if (!/[\s(,;]/.test(prev)) return false;
	}
	TAG_RE.lastIndex = start;
	const m = TAG_RE.exec(state.src);
	if (!m) return false;
	const name = m[1].replace(/[-/]+$/, '');
	if (!silent) {
		const tok = state.push('tag', '', 0);
		tok.content = name.toLowerCase();
	}
	state.pos = start + 1 + name.length;
	return true;
}

/** `${ ... }` SilverBullet expression: inert chip. Brace balanced. */
function exprRule(state: any, silent: boolean): boolean {
	const src: string = state.src;
	const start = state.pos;
	if (src.charCodeAt(start) !== 0x24 || src.charCodeAt(start + 1) !== 0x7b) return false;
	let depth = 0;
	let i = start + 1;
	for (; i < src.length; i++) {
		const c = src[i];
		if (c === '{') depth++;
		else if (c === '}' && --depth === 0) break;
	}
	if (depth !== 0 || i >= src.length) return false;
	if (!silent) {
		const tok = state.push('expr_chip', '', 0);
		tok.content = src.slice(start, i + 1);
	}
	state.pos = i + 1;
	return true;
}

function mathInlineRule(state: any, silent: boolean): boolean {
	const src: string = state.src;
	const start = state.pos;
	if (src.charCodeAt(start) !== 0x24) return false;
	const display = src.charCodeAt(start + 1) === 0x24;
	const open = display ? 2 : 1;
	const first = src[start + open];
	if (first === undefined || (!display && /[\s\d]/.test(first))) return false;
	let i = start + open;
	for (; i < src.length; i++) {
		if (src[i] === '\\') {
			i++;
			continue;
		}
		if (!display && src[i] === '\n') return false;
		if (display ? src.startsWith('$$', i) : src[i] === '$') break;
	}
	if (i >= src.length) return false;
	const content = src.slice(start + open, i);
	if (!display && (/\s$/.test(content) || /\d/.test(src[i + 1] ?? ''))) return false;
	if (content.trim() === '') return false;
	if (!silent) {
		const tok = state.push('math', '', 0);
		tok.content = content;
		tok.meta = { display };
	}
	state.pos = i + open;
	return true;
}

function mathBlockRule(state: any, startLine: number, endLine: number, silent: boolean): boolean {
	let pos = state.bMarks[startLine] + state.tShift[startLine];
	const max = state.eMarks[startLine];
	if (state.sCount[startLine] - state.blkIndent >= 4) return false;
	if (state.src.slice(pos, pos + 2) !== '$$') return false;
	const firstRest = state.src.slice(pos + 2, max);
	let content = '';
	let line = startLine;
	let found = false;
	if (firstRest.trim().endsWith('$$') && firstRest.trim().length > 2) {
		content = firstRest.trim().slice(0, -2);
		found = true;
	} else {
		content = firstRest;
		for (line = startLine + 1; line < endLine; line++) {
			pos = state.bMarks[line] + state.tShift[line];
			const lineText = state.src.slice(pos, state.eMarks[line]);
			if (lineText.trim().endsWith('$$')) {
				content += '\n' + lineText.trim().slice(0, -2);
				found = true;
				break;
			}
			content += '\n' + lineText;
		}
	}
	if (!found) return false;
	if (silent) return true;
	state.line = line + 1;
	const tok = state.push('math', '', 0);
	tok.block = true;
	tok.content = content.trim();
	tok.meta = { display: true };
	tok.map = [startLine, line + 1];
	return true;
}

function resolveUrl(url: string, dir: string): string {
	if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url)) return url;
	if (url.startsWith('/')) return '/f' + url;
	const [pathPart, rest] = splitFirst(url, '#');
	const hash = rest !== undefined ? '#' + rest : '';
	const parts = (dir ? dir.split('/') : []).concat(decodeURI(pathPart).split('/'));
	const stack: string[] = [];
	for (const p of parts) {
		if (p === '..') stack.pop();
		else if (p && p !== '.') stack.push(p);
	}
	const joined = stack.join('/');
	if (/\.md$/i.test(joined)) return '/' + encodeURI(joined.replace(/\.md$/i, '')) + hash;
	return '/f/' + encodeURI(joined) + hash;
}

export function createMarkdown() {
	const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false });
	md.inline.ruler.before('link', 'wikilink', wikilinkRule);
	md.inline.ruler.before('text', 'tag', tagRule);
	md.inline.ruler.before('text', 'expr_chip', exprRule);
	md.inline.ruler.before('escape', 'math', mathInlineRule);
	md.block.ruler.before('fence', 'math_block', mathBlockRule, {
		alt: ['paragraph', 'reference', 'blockquote', 'list']
	});

	// collect headings (with unique slugs) and task checkboxes
	md.core.ruler.push('folio_post', (state) => {
		const env = state.env as RenderEnv;
		env.headings = [];
		env.slugs = new Map();
		const toks = state.tokens;
		for (let i = 0; i < toks.length; i++) {
			const t = toks[i];
			if (t.type === 'heading_open') {
				const inline = toks[i + 1];
				const text = plainInline(inline);
				let slug = slugify(text);
				const n = env.slugs.get(slug) ?? 0;
				env.slugs.set(slug, n + 1);
				if (n > 0) slug = `${slug}-${n}`;
				t.attrSet('id', slug);
				env.headings.push({ level: Number(t.tag.slice(1)), text, slug });
			}
			if (t.type === 'list_item_open') markTask(toks, i, env, state.Token);
		}
		return true;
	});

	const r = md.renderer.rules;

	r.wikilink = (tokens, idx, _o, env: any) => {
		const { target, heading, alias } = tokens[idx].meta as unknown as WikiLink;
		(env.links ??= []).push({ target, heading, alias });
		const resolved = target ? (env.resolve?.(target) ?? null) : env.dir !== undefined ? '' : null;
		const label = alias ?? (target ? target + (heading ? `#${heading}` : '') : `#${heading}`);
		const frag = heading ? '#' + slugify(heading) : '';
		if (target === '') return `<a class="wikilink" href="${frag}">${escapeHtml(label)}</a>`;
		if (resolved) {
			const href = '/' + encodeURI(resolved) + frag;
			return `<a class="wikilink" href="${href}">${escapeHtml(label)}</a>`;
		}
		const href = '/' + encodeURI(target.replace(/^\//, ''));
		return `<a class="wikilink missing" href="${href}" title="Page does not exist yet">${escapeHtml(label)}</a>`;
	};

	r.tag = (tokens, idx, _o, env: any) => {
		const name = tokens[idx].content;
		(env.tags ??= new Set()).add(name);
		return `<a class="tag" href="/tag/${encodeURI(name)}">#${escapeHtml(name)}</a>`;
	};

	r.expr_chip = (tokens, idx) =>
		`<span class="chip inert" title="${escapeHtml(tokens[idx].content)}">&#402; expression (not executed)</span>`;

	r.math = (tokens, idx, _o, env: any) => {
		(env.usedClient ??= new Set()).add('katex');
		const t = tokens[idx];
		const display = (t.meta as { display: boolean }).display;
		const tag = display ? 'div' : 'span';
		return `<${tag} class="math ${display ? 'display' : 'inline'}" data-diagram="katex">${escapeHtml(t.content)}</${tag}>${t.block ? '\n' : ''}`;
	};

	r.fence = (tokens, idx, _o, env: any) => {
		const t = tokens[idx];
		const lang = t.info.trim().split(/\s+/)[0].toLowerCase();
		const code = t.content;
		if (INERT_FENCES.has(lang)) {
			const lines = code.split('\n').length - 1;
			return (
				`<details class="chip-block inert"><summary><span class="chip inert">${escapeHtml(lang)} block (not executed, ${lines} lines)</span></summary>` +
				`<pre><code>${escapeHtml(code)}</code></pre></details>\n`
			);
		}
		const dia = lang ? diagramForLang(lang) : undefined;
		if (dia?.runtime === 'client') {
			(env.usedClient ??= new Set()).add(dia.id);
			const tag = dia.id === 'katex' ? 'div class="math display"' : 'div class="diagram"';
			return `<${tag} data-diagram="${dia.id}"><pre class="diagram-src">${escapeHtml(code)}</pre></${tag.split(' ')[0]}>\n`;
		}
		if (dia?.runtime === 'kroki') {
			const jobs = (env.jobs ??= []);
			const id = jobs.length;
			jobs.push({ id, kroki: dia.kroki!, label: dia.label, source: code });
			return `<!--kroki:${id}-->\n`;
		}
		let inner: string;
		let cls = '';
		if (lang && hljs.getLanguage(lang)) {
			inner = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
			cls = ` class="hljs language-${escapeHtml(lang)}"`;
		} else {
			inner = escapeHtml(code);
		}
		return `<pre><code${cls}>${inner}</code></pre>\n`;
	};

	const defaultLinkOpen = r.link_open ?? ((t, i, o, _e, s) => s.renderToken(t, i, o));
	r.link_open = (tokens, idx, opts, env: any, self) => {
		const t = tokens[idx];
		const href = String(t.attrGet('href') ?? '');
		if (/^https?:\/\//i.test(href)) {
			t.attrSet('target', '_blank');
			t.attrSet('rel', 'noopener noreferrer');
		} else if (!/^(mailto:|tel:|#)/i.test(href)) {
			t.attrSet('href', resolveUrl(href, env.dir ?? ''));
		}
		return defaultLinkOpen(tokens, idx, opts, env, self);
	};
	const defaultImage = r.image!;
	r.image = (tokens, idx, opts, env: any, self) => {
		const t = tokens[idx];
		const src = String(t.attrGet('src') ?? '');
		t.attrSet('src', resolveUrl(src, env.dir ?? ''));
		t.attrSet('loading', 'lazy');
		return defaultImage(tokens, idx, opts, env, self);
	};

	r.task_checkbox = (tokens, idx) => {
		const { checked, line } = tokens[idx].meta as { checked: boolean; line: number };
		return `<input type="checkbox" class="task" data-line="${line}"${checked ? ' checked' : ''}> `;
	};

	r.table_open = () => '<div class="table-wrap"><table>\n';
	r.table_close = () => '</table></div>\n';

	return md;
}

function plainInline(tok: Token | undefined): string {
	if (!tok?.children) return tok?.content ?? '';
	return tok.children
		.map((c) => {
			if (c.type === 'wikilink') {
				const m = c.meta as unknown as WikiLink;
				return m.alias ?? m.target;
			}
			if (c.type === 'tag') return '#' + c.content;
			if (c.type === 'text' || c.type === 'code_inline') return c.content;
			if (c.type === 'softbreak') return ' ';
			return '';
		})
		.join('');
}

const TASK_RE = /^\[([ xX])\][ \t]+/;

function markTask(toks: Token[], i: number, env: RenderEnv, TokenCtor: typeof Token): void {
	// list_item_open, paragraph_open, inline
	const para = toks[i + 1];
	const inline = toks[i + 2];
	if (para?.type !== 'paragraph_open' || inline?.type !== 'inline' || !inline.children?.length) return;
	const first = inline.children[0];
	if (first.type !== 'text') return;
	const m = TASK_RE.exec(first.content);
	if (!m || !inline.map) return;
	first.content = first.content.slice(m[0].length);
	const checked = m[1] !== ' ';
	const cb = new TokenCtor('task_checkbox', '', 0);
	cb.meta = { checked, line: inline.map[0] + (env.lineOffset ?? 0) };
	inline.children.unshift(cb);
	toks[i].attrJoin('class', 'task-item');
	toks[i].attrSet('data-checked', String(checked));
}

const md = createMarkdown();

export interface Analysis {
	frontmatter: Record<string, unknown>;
	frontmatterError?: string;
	tags: string[];
	links: WikiLink[];
	headings: { level: number; text: string; slug: string }[];
	text: string;
}

function inlineText(tok: Token): string {
	if (!tok.children) return tok.content;
	return tok.children
		.map((c) => {
			switch (c.type) {
				case 'text':
				case 'code_inline':
					return c.content;
				case 'wikilink': {
					const m = c.meta as unknown as WikiLink;
					return m.alias ?? m.target;
				}
				case 'tag':
					return '#' + c.content;
				case 'softbreak':
				case 'hardbreak':
					return '\n';
				default:
					return '';
			}
		})
		.join('');
}

/** Parses once (no rendering) and extracts everything the index needs. */
export function analyze(raw: string): Analysis {
	const fm = parseFrontmatter(raw);
	const env: RenderEnv = { lineOffset: fm.lineOffset, links: [], tags: new Set() };
	const tokens = md.parse(fm.body, env as never);
	// the wikilink/tag renderers collect into env; run the lightweight collection by walking tokens
	const links: WikiLink[] = [];
	const tags = new Set(frontmatterTags(fm.data));
	const parts: string[] = [];
	for (const t of tokens) {
		if (t.type === 'inline') {
			parts.push(inlineText(t));
			for (const c of t.children ?? []) {
				if (c.type === 'wikilink') links.push(c.meta as unknown as WikiLink);
				else if (c.type === 'tag') tags.add(c.content);
			}
		} else if (t.type === 'fence' && !INERT_FENCES.has(t.info.trim().split(/\s+/)[0].toLowerCase())) {
			parts.push(t.content);
		} else if (t.type === 'math') parts.push(t.content);
	}
	return {
		frontmatter: fm.data,
		frontmatterError: fm.error,
		tags: [...tags],
		links,
		headings: env.headings ?? [],
		text: parts.join('\n')
	};
}

export interface Rendered {
	html: string;
	jobs: KrokiJob[];
	usedClient: string[];
	headings: { level: number; text: string; slug: string }[];
}

export function renderBody(body: string, env: RenderEnv): Rendered {
	const html = md.render(body, env as never);
	return {
		html,
		jobs: env.jobs ?? [],
		usedClient: [...(env.usedClient ?? [])],
		headings: env.headings ?? []
	};
}

export { escapeHtml };
