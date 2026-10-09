import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { matchWidget } from '../src/lib/server/markdown';
import { widgetQuery } from '../src/lib/server/widgets';
import { makeMdwiki } from './helpers';

const open: { stop(): void }[] = [];
afterEach(() => open.splice(0).forEach((f) => f.stop()));

// the exact expressions used by the real knowledge base
const RECENT = (tag: string, n = 200) =>
	`\${(kb and kb.safe("Serverliste", function() return kb.recent("${tag}", ${n}) end)) or "*Liste nicht verfügbar: das Modul [[Library/Wissensbasis-Home]] lädt nicht.*"}`;
const HEADER = '${(kb and kb.safe("Statuszeile", kb.header)) or "*Statuszeile nicht verfügbar: das Modul [[Library/Wissensbasis-Home]] lädt nicht.*"}';
const CATS = '${(kb and kb.safe("Kategorien", kb.categories)) or "*Kategorien nicht verfügbar.*"}';

async function setup(pages: Record<string, string>) {
	const made = await makeMdwiki({ poll: 100 });
	open.push(made.mdwiki);
	for (const [p, c] of Object.entries(pages)) {
		fs.mkdirSync(path.dirname(path.join(made.dir, p)), { recursive: true });
		fs.writeFileSync(path.join(made.dir, p), c);
	}
	await made.mdwiki.index.refresh();
	return made;
}

describe('widgets as query presets', () => {
	it('maps each kb.* widget to a fixed pages query', () => {
		expect(widgetQuery({ kind: 'recent', tag: 'server', limit: 5 })).toEqual({ tag: 'server', sort: 'date desc', limit: 5, show: 'list' });
		expect(widgetQuery({ kind: 'section', tag: 'server' })).toEqual({ tag: 'server', show: 'count' });
		// header and categories are not a page query; they keep their own built-in rendering
		expect(widgetQuery({ kind: 'header' }).show).toBe('count');
		expect(widgetQuery({ kind: 'categories' }).show).toBe('count');
	});
});

describe('widget recognition', () => {
	it('matches the four shapes and the short forms', () => {
		expect(matchWidget('${kb.section("server")}')).toEqual({ kind: 'section', tag: 'server' });
		expect(matchWidget(RECENT('server'))).toEqual({ kind: 'recent', tag: 'server', limit: 200 });
		expect(matchWidget(RECENT('Server', 5))).toEqual({ kind: 'recent', tag: 'server', limit: 5 });
		expect(matchWidget(HEADER)).toEqual({ kind: 'header' });
		expect(matchWidget(CATS)).toEqual({ kind: 'categories' });
		expect(matchWidget('${kb.recent("x", 5)}')).toEqual({ kind: 'recent', tag: 'x', limit: 5 });
		expect(matchWidget('${ kb.header() }')).toEqual({ kind: 'header' });
		expect(matchWidget('${kb.categories()}')).toEqual({ kind: 'categories' });
		expect(matchWidget('${\n  kb.section( "a" )\n}')).toEqual({ kind: 'section', tag: 'a' });
	});

	it.each([
		'${kb.sections("server")}',
		'${kb.section(tag)}',
		'${kb.section("a" .. "b")}',
		'${kb.section("server") .. os.execute("x")}',
		'${kb.recent(tag, 5)}',
		'${(kb and kb.safe("L", function() return kb.recent("a", n) end)) or "x"}',
		'${(kb and kb.safe("L", function() os.exit() return kb.recent("a", 5) end)) or "x"}',
		'${(kb and kb.safe("L", kb.other)) or "x"}',
		'${kb.header(1)}'
	])('leaves %s as an inert chip', async (expr) => {
		expect(matchWidget(expr)).toBeNull();
		const { mdwiki } = await setup({ 'T.md': `\n${expr}\n` });
		const v = await mdwiki.renderPage('T');
		expect(v!.html).toContain('class="chip inert"');
		expect(v!.html).not.toContain('class="wg');
	});

	it('runs a body that is not a kb remnant: ${1 + 1} now evaluates', async () => {
		expect(matchWidget('${1 + 1}')).toBeNull();
		const { mdwiki } = await setup({ 'T.md': '\n${1 + 1}\n' });
		const v = await mdwiki.renderPage('T');
		expect(v!.html).toContain('<p>2</p>');
		expect(v!.html).not.toContain('class="chip');
	});

	it('shows an unknown method call as a red error chip, not a quiet one', async () => {
		const { mdwiki } = await setup({ 'T.md': '\n${team.openTasks()}\n' });
		const v = await mdwiki.renderPage('T');
		expect(v!.html).toContain('class="chip error"');
		expect(v!.html).toContain('team.openTasks()');
	});
});

describe('widget rendering', () => {
	it('renders section, recent, header and categories from the index', async () => {
		const { mdwiki } = await setup({
			'W.md': `\n\${kb.section("server")}\n\n${RECENT('server')}\n\n${HEADER}\n\n${CATS}\n`,
			'Server/Newer.md': '---\ntags: server\ndate: 2026-10-09\n---\nx\n'
		});
		const v = (await mdwiki.renderPage('W'))!;
		expect(v.html).not.toContain('chip inert');
		expect(v.html).toContain('wg-section');
		expect(v.html).toContain('<span class="wg-label">Server</span>');
		expect(v.html).toContain('3 notes'); // Alpha, Beta, Newer (the Server page itself is not counted)
		expect(v.html).toContain('last 2026-10-09');
		// recent: newest by frontmatter date first, with the date at the right
		expect(v.html.indexOf('/Server/Newer')).toBeLessThan(v.html.indexOf('/Server/Alpha'));
		expect(v.html).toContain('<span class="wg-date">2026-10-09</span>');
		expect(v.html).toContain('in <strong>2</strong> categories');
		expect(v.html).toMatch(/wg-card[^>]*href="\/Notes\/Garten"/);
		// the label and fallback of kb.safe are never shown
		expect(v.html).not.toContain('Serverliste');
		expect(v.html).not.toContain('nicht verfügbar');
	});

	it('limits the list, shows the empty message and warns on unknown categories', async () => {
		const { mdwiki } = await setup({ 'W.md': `\n${RECENT('server', 1)}\n\n\${kb.recent("nothing")}\n\n\${kb.section("nope")}\n` });
		const v = (await mdwiki.renderPage('W'))!;
		expect(v.html.match(/class="wg-date"/g)).toHaveLength(1);
		expect(v.html).toContain('No note in this category yet.');
		expect(v.html).toContain('Unknown category: nope');
	});

	it('escapes titles, tags and categories', async () => {
		const { mdwiki } = await setup({
			'W.md': '\n${kb.recent("evil")}\n\n${kb.section("<b>x</b>")}\n',
			'Evil <img src=x onerror=alert(1)>.md': '---\ntags: evil\ndate: "<script>1</script>"\n---\nx\n'
		});
		const v = (await mdwiki.renderPage('W'))!;
		expect(v.html).not.toContain('<img');
		expect(v.html).not.toContain('<script>');
		expect(v.html).not.toContain('<b>x</b>');
		expect(v.html).toContain('&lt;img');
	});

	it('does not append the automatic tag list on pages with a recent widget', async () => {
		const { mdwiki } = await setup({ 'Server.md': '---\ntags: server\n---\n\n${kb.recent("server", 5)}\n' });
		expect((await mdwiki.renderPage('Server'))!.tagLists).toEqual([]);
		// pages without the widget keep the automatic list
		expect((await mdwiki.renderPage('Notes/Garten'))!.tagLists.map((l) => l.tag)).toEqual(['garten']);
	});

	it('updates counts and lists after a poll that adds a tagged page', async () => {
		const { mdwiki, dir } = await setup({ 'W.md': '\n${kb.section("server")}\n\n${kb.recent("server", 10)}\n' });
		const before = (await mdwiki.renderPage('W'))!;
		expect(before.html).toContain('2 notes');
		fs.writeFileSync(path.join(dir, 'Server/Gamma.md'), '---\ntags: server\ndate: 2030-01-01\n---\nx\n');
		await new Promise((r) => setTimeout(r, 450));
		const after = (await mdwiki.renderPage('W'))!;
		expect(after.html).toContain('3 notes');
		expect(after.html).toContain('last 2030-01-01');
		expect(after.html).toContain('/Server/Gamma');
	});
});
