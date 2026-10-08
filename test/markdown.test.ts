import { describe, expect, it } from 'vitest';
import { analyze, renderBody } from '../src/lib/server/markdown';

const render = (src: string, known: Record<string, string> = {}) =>
	renderBody(src, { dir: '', resolve: (t) => known[t] ?? null });

describe('wikilinks', () => {
	it('renders [[P]], [[P|alias]] and [[P#H]]', () => {
		const known = { Page: 'Page', 'Dir/Other': 'Dir/Other' };
		const { html } = render('[[Page]] [[Page|shown]] [[Dir/Other#My Heading]]', known);
		expect(html).toContain('<a class="wikilink" href="/Page">Page</a>');
		expect(html).toContain('<a class="wikilink" href="/Page">shown</a>');
		expect(html).toContain('href="/Dir/Other#my-heading"');
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
		expect(html).toContain('data-line="4" checked');
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
