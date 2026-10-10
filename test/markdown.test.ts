import { describe, expect, it } from 'vitest';
import { analyze, renderBody, sectionOf } from '../src/lib/server/markdown';

const render = (src: string, known: Record<string, string> = {}, label?: (p: string) => string) =>
	renderBody(src, { dir: '', resolve: (t) => known[t] ?? null, label });

describe('wikilinks', () => {
	it('renders [[P]], [[P|alias]] and [[P#H]]', () => {
		const known = { Page: 'Page', 'Dir/Other': 'Dir/Other' };
		const { html } = render('[[Page]] [[Page|shown]] [[Dir/Other#My Heading]]', known);
		expect(html).toContain('<a class="wikilink" href="/Page" title="Page">Page</a>');
		expect(html).toContain('<a class="wikilink" href="/Page" title="Page">shown</a>');
		expect(html).toContain('href="/Dir/Other#my-heading"');
		expect(html).toContain('Dir/Other › My Heading');
	});

	it('labels a resolved link with the page name, not the raw target path', () => {
		const known = { 'Server/personal01': 'Server/personal01' };
		const label = (p: string) => p.slice(p.lastIndexOf('/') + 1);
		const { html } = render('see [[Server/personal01]]', known, label);
		expect(html).toContain('href="/Server/personal01" title="Server/personal01">personal01</a>');
		expect(html).not.toContain('>Server/personal01</a>');
	});

	it('keeps an explicit alias and the heading on a named link', () => {
		const known = { 'Konventionen/Sprache': 'Konventionen/Sprache' };
		const label = (p: string) => p.slice(p.lastIndexOf('/') + 1);
		const { html } = render('[[Konventionen/Sprache|Regeln]] [[Konventionen/Sprache#Ton]]', known, label);
		expect(html).toContain('title="Konventionen/Sprache">Regeln</a>');
		expect(html).toContain('>Sprache › Ton</a>');
	});

	it('marks unresolved links as missing and keeps code spans literal', () => {
		const { html } = render('[[Nope]] and `[[Page]]`');
		expect(html).toContain('class="wikilink missing"');
		expect(html).toContain('<code>[[Page]]</code>');
	});

	it('extracts link targets for the index', () => {
		const a = analyze('[[A]] [[B|x]] [[C#h]]');
		expect(a.links).toEqual([
			{ target: 'A', heading: undefined, alias: undefined },
			{ target: 'B', heading: undefined, alias: 'x' },
			{ target: 'C', heading: 'h', alias: undefined }
		]);
	});
});

describe('tags', () => {
	it('collects inline and frontmatter tags, ignores numbers and headings', () => {
		const a = analyze('---\ntags: [One, two]\n---\n# Heading\n\ntext #inline and #Nested/Tag but not #123 or a#b\n');
		expect(a.tags.sort()).toEqual(['inline', 'nested/tag', 'one', 'two']);
	});

	it('accepts a space/comma separated frontmatter string', () => {
		expect(analyze('---\ntags: a, b c\n---\nx').tags.sort()).toEqual(['a', 'b', 'c']);
	});
});

describe('SilverBullet-only syntax is inert', () => {
	it('renders lua, query and ${} as chips without executing or leaking markup', () => {
		const { html } = render('```space-lua\nprint(1)\n```\n\n```query\nx\n```\n\nvalue ${<script>alert(1)</script>}');
		expect(html.match(/chip-block inert/g)).toHaveLength(2);
		expect(html).toContain('class="chip inert"');
		expect(html).not.toContain('<script>');
	});

	it('labels the placeholders plainly and runs nothing', () => {
		const { html } = render('```space-lua\nprint(1)\n```\n\nvalue ${kb.section(tag)}');
		// block: language name + "not run", with a readable line count
		expect(html).toContain('space-lua · not run');
		expect(html).toContain('1 line');
		expect(html).toContain('click to read');
		// inline: "not run" and no stray symbol, the raw source in the tooltip
		expect(html).toContain('>expression · not run</span>');
		expect(html).not.toContain('&#402;');
		expect(html).not.toContain('not executed');
	});
});

describe('other syntax', () => {
	it('escapes raw HTML', () => {
		expect(render('<img src=x onerror=alert(1)>').html).not.toContain('<img');
	});

	it('numbers task checkboxes with their source line, offset by frontmatter', () => {
		const src = '---\na: 1\n---\n- [ ] one\n- [x] two\n';
		const body = src.slice(src.indexOf('- [ ]'));
		const { html } = renderBody(body, { lineOffset: 3 });
		expect(html).toContain('data-line="3"');
		expect(html).toContain('data-line="4" disabled checked');
	});

	it('emits client placeholders and kroki jobs from one registry', () => {
		const r = render('```mermaid\ngraph TD\n```\n\n```dot\ndigraph{}\n```\n\n$x^2$ and $$y$$');
		expect(r.html).toContain('data-diagram="mermaid"');
		expect(r.jobs).toMatchObject([{ kroki: 'graphviz', label: 'Graphviz' }]);
		expect(r.usedClient.sort()).toEqual(['katex', 'mermaid']);
		expect(r.html).toContain('class="math inline"');
	});

	it('leaves currency alone', () => {
		expect(render('costs $5 and $6').html).not.toContain('class="math');
	});

	it('resolves relative images and links against the page folder', () => {
		const { html } = renderBody('![x](_attachments/a%20b.png) [d](../Other.md)', { dir: 'Server' });
		expect(html).toContain('src="/f/Server/_attachments/a%20b.png"');
		expect(html).toContain('href="/Other"');
	});
});

describe('footnotes', () => {
	it('renders references, a footnote list and back links', () => {
		const { html } = render('Text[^a] more[^b].\n\n[^a]: First note.\n[^b]: Second.');
		expect(html).toContain('<sup class="footnote-ref"><a href="#fn1" id="fnref1">[1]</a></sup>');
		expect(html).toContain('class="footnotes"');
		expect(html).toContain('First note.');
		expect(html).toContain('href="#fnref1"');
	});

	it('suffixes ids when the body is embedded (docId)', () => {
		const html = renderBody('x[^a]\n\n[^a]: n', { dir: '', docId: 'e0' }).html;
		expect(html).toContain('href="#fn-e0-1"');
		expect(html).toContain('id="fnref-e0-1"');
	});
});

describe('emoji', () => {
	it('replaces known shortcodes and leaves unknown ones and code alone', () => {
		const { html } = render(':tada: :+1: :nope: `:tada:`');
		expect(html).toContain('🎉 👍 :nope: <code>:tada:</code>');
	});

	it('does not eat times or URLs', () => {
		expect(render('at 10:30:15 see http://a.b').html).toContain('10:30:15');
	});
});

describe('callouts', () => {
	it('turns [!type] blockquotes into callouts with a title', () => {
		const { html } = render('> [!tip] Short cut\n> Body **text**');
		expect(html).toContain('class="callout callout-tip" data-callout="tip"');
		expect(html).toContain('<span class="callout-name">Short cut</span>');
		expect(html).toContain('<strong>text</strong>');
		expect(html).not.toContain('[!tip]');
		expect(html).not.toContain('<blockquote');
	});

	it('defaults the title to the type, maps aliases, and handles an empty body', () => {
		const { html } = render('> [!caution]');
		expect(html).toContain('callout-warning');
		expect(html).toContain('<span class="callout-name">Caution</span>');
	});

	it('makes +/- callouts foldable', () => {
		expect(render('> [!note]- Hidden\n> x').html).toContain('<details class="callout callout-note" data-callout="note">');
		expect(render('> [!note]+ Open\n> x').html).toContain('<details class="callout callout-note" data-callout="note" open>');
	});

	it('escapes the title and leaves plain quotes alone', () => {
		expect(render('> [!note] <b>x</b>\n> y').html).toContain('&lt;b&gt;x&lt;/b&gt;');
		expect(render('> just a quote').html).toContain('<blockquote>');
	});

	it('supports nested content and a callout inside a callout', () => {
		const { html } = render('> [!note] Outer\n> a\n>\n> > [!warning] Inner\n> > b');
		expect(html).toContain('callout-note');
		expect(html).toContain('callout-warning');
		expect(html.match(/<\/div><\/div>/g)?.length).toBe(2);
	});
});

describe('embeds', () => {
	it('collects ![[Page]] and ![[Page#Heading]] as placeholders and index links', () => {
		const r = render('![[A]]\n\n![[B#Sec]]');
		expect(r.embeds).toEqual([{ target: 'A', heading: undefined }, { target: 'B', heading: 'Sec' }]);
		expect(r.html).toContain('<!--embed:0-->');
		expect(analyze('![[A]] ![[B#Sec]]').links.map((l) => l.target)).toEqual(['A', 'B']);
	});

	it('embeds an image file as an image', () => {
		expect(renderBody('![[pic.png]]', { dir: 'Dir' }).html).toContain('<img src="/f/Dir/pic.png"');
	});

	it('extracts a section up to the next heading of the same or higher level', () => {
		const body = '# T\nintro\n## A\na1\n### A.1\nsub\n## B\nb1';
		expect(sectionOf(body, 'A')).toBe('a1\n### A.1\nsub');
		expect(sectionOf(body, 'B')).toBe('b1');
		expect(sectionOf(body, 'Nope')).toBeNull();
	});
});
