import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeMdwiki } from './helpers';

const open: { stop(): void }[] = [];
afterEach(() => open.splice(0).forEach((f) => f.stop()));
async function setup(opts?: Parameters<typeof makeMdwiki>[0]) {
	const r = await makeMdwiki(opts);
	open.push(r.mdwiki);
	return r;
}

describe('index', () => {
	it('does not follow directory symlinks: a loop indexes each page once and the scan finishes', async () => {
		const { mdwiki, dir } = await setup();
		fs.mkdirSync(path.join(dir, 'Loop'));
		fs.writeFileSync(path.join(dir, 'Loop/a.md'), 'a');
		fs.symlinkSync('.', path.join(dir, 'Loop/loop'));
		fs.symlinkSync('..', path.join(dir, 'Loop/up'));
		const files = (await mdwiki.store.scan()).map((f) => f.rel).filter((r) => r.startsWith('Loop'));
		expect(files).toEqual(['Loop/a.md']);
	});

	it('resolves links by path, case, folder and unique basename; computes backlinks', async () => {
		const { mdwiki } = await setup();
		const back = mdwiki.getBacklinks('Server/Alpha').map((b) => b.path);
		expect(back).toEqual(expect.arrayContaining(['Server/Beta', 'index', 'Library/Hidden']));
		// [[alpha|...]] resolves case-insensitively to Server/Alpha
		expect(mdwiki.index.resolve('alpha', 'Server/Beta')).toBe('Server/Alpha');
		expect(mdwiki.index.resolve('Beta', 'Server/Alpha')).toBe('Server/Beta');
		expect(mdwiki.index.resolve('Does Not Exist', 'index')).toBeNull();
	});

	it('labels a link with the page name, adding the folder only when the name is ambiguous', async () => {
		const { mdwiki } = await setup();
		// unique basenames render as the name alone
		expect(mdwiki.index.displayName('Server/Alpha')).toBe('Alpha');
		expect(mdwiki.index.displayName('Server/Beta')).toBe('Beta');
		expect(mdwiki.index.displayName('Syntax')).toBe('Syntax');
		// a second page with the same name makes both keep their folder
		await mdwiki.writePage('Notes/Alpha', 'a duplicate name');
		expect(mdwiki.index.displayName('Server/Alpha')).toBe('Server/Alpha');
		expect(mdwiki.index.displayName('Notes/Alpha')).toBe('Notes/Alpha');
	});

	it('renders wikilinks with the page name and keeps the full path in the title', async () => {
		const { mdwiki } = await setup();
		const view = await mdwiki.renderPage('index');
		const html = view!.html;
		// [[Server/Alpha|Alpha, aliased]] keeps the alias
		expect(html).toContain('title="Server/Alpha">Alpha, aliased</a>');
		// [[Server/Alpha#Setup Steps]] shows the page name and the heading
		expect(html).toContain('href="/Server/Alpha#setup-steps" title="Server/Alpha → Setup Steps">Alpha › Setup Steps</a>');
		// [[Syntax]] is unique, so no folder prefix is shown
		expect(html).toContain('href="/Syntax" title="Syntax">Syntax</a>');
		// an unresolved link still shows what is missing
		expect(html).toContain('class="wikilink missing"');
	});

	it('titles pages from frontmatter, then the first H1, then the filename', async () => {
		const { mdwiki } = await setup();
		// frontmatter title wins
		expect(mdwiki.index.get('Syntax')?.title).toBe('Syntax');
		// first H1 when there is no frontmatter title (index.md -> "# Home")
		expect(mdwiki.index.get('index')?.title).toBe('Home');
		// filename stub when neither exists (Notes/Garten.md has no title and no H1)
		expect(mdwiki.index.get('Notes/Garten')?.title).toBe('Garten');
		// a plain page falls back to its own name
		expect(mdwiki.index.get('Server/Alpha')?.title).toBe('Alpha');
	});

	it('uses titles in the sidebar tree, folders keep their name', async () => {
		const { mdwiki } = await setup();
		const flat = (nodes: ReturnType<typeof mdwiki.tree>): { name: string; path: string }[] =>
			nodes.flatMap((n) => [{ name: n.name, path: n.path }, ...flat(n.children)]);
		const nodes = flat(mdwiki.tree());
		expect(nodes.find((n) => n.path === 'index')?.name).toBe('Home');
		expect(nodes.find((n) => n.path === 'Syntax')?.name).toBe('Syntax');
		// the Server folder has a page, so its label is the page title ("Server" has no H1 other than the name)
		expect(nodes.find((n) => n.path === 'Server')?.name).toBe('Server');
	});

	it('collects frontmatter and inline tags and hides Library', async () => {
		const { mdwiki } = await setup();
		const tags = Object.fromEntries(mdwiki.listTags().map((t) => [t.name, t.count]));
		expect(tags.server).toBe(3);
		expect(tags['alpha-tag']).toBe(1);
		expect(tags.infra).toBe(1);
		expect(mdwiki.listPages().map((p) => p.path)).not.toContain('Library/Hidden');
		expect(mdwiki.listPages('Library').map((p) => p.path)).toContain('Library/Hidden');
		expect(mdwiki.pagesByTag('server').map((p) => p.path)).toEqual(['Server', 'Server/Alpha', 'Server/Beta']);
	});

	it('appends "Pages tagged" lists via CONFIG tagPage mapping and name match', async () => {
		const { mdwiki } = await setup();
		const server = await mdwiki.renderPage('Server');
		expect(server!.tagLists.map((l) => l.tag)).toEqual(['server']);
		expect(server!.tagLists[0].pages.map((p) => p.path)).toEqual(['Server/Alpha', 'Server/Beta']);
		const garten = await mdwiki.renderPage('Notes/Garten');
		expect(garten!.tagLists.map((l) => l.tag)).toEqual(['garten']);
		expect(garten!.tagLists[0].pages.map((p) => p.path)).toEqual(['index']);
	});

	it('searches full text with snippets, titles first', async () => {
		const { mdwiki } = await setup();
		const hits = mdwiki.search('zebrafish').results;
		expect(hits.map((h) => h.path)).toEqual(['Server/Beta']);
		expect(hits[0].snippet).toContain('zebrafish-needle');
		expect(mdwiki.search('beta').results[0].path).toBe('Server/Beta');
		expect(mdwiki.search('print').results).toEqual([]); // inert Lua is not indexed
	});

	it('renders unique heading slugs and keeps frontmatter out of the body', async () => {
		const { mdwiki } = await setup();
		const v = await mdwiki.renderPage('Server/Alpha');
		expect(v!.headings.map((h) => h.slug)).toEqual(['alpha', 'setup-steps', 'setup-steps-1']);
		expect(v!.html).not.toContain('2026-10-01');
	});
});

describe('external changes (mtime poll)', () => {
	it('shows a file written outside the app in search and backlinks after one poll cycle', async () => {
		const { mdwiki, dir } = await setup({ poll: 100 });
		expect(mdwiki.search('quokka-marker').results).toEqual([]);
		fs.writeFileSync(path.join(dir, 'External.md'), 'quokka-marker links to [[Server/Beta]]\n');
		await new Promise((r) => setTimeout(r, 450));
		expect(mdwiki.search('quokka-marker').results.map((h) => h.path)).toEqual(['External']);
		expect(mdwiki.getBacklinks('Server/Beta').map((b) => b.path)).toContain('External');
		// modification and deletion are picked up as well
		fs.writeFileSync(path.join(dir, 'External.md'), 'axolotl-marker\n');
		await new Promise((r) => setTimeout(r, 450));
		expect(mdwiki.search('quokka-marker').results).toEqual([]);
		expect(mdwiki.search('axolotl-marker').results).toHaveLength(1);
		fs.rmSync(path.join(dir, 'External.md'));
		await new Promise((r) => setTimeout(r, 450));
		expect(mdwiki.search('axolotl-marker').results).toEqual([]);
	});
});

describe('read-only UI', () => {
	it('renders task checkboxes disabled and the service has no UI write helpers', async () => {
		const { mdwiki } = await setup();
		const v = await mdwiki.renderPage('Server/Beta');
		expect(v!.html).toMatch(/<input type="checkbox" class="task" data-line="\d+" disabled>/);
		expect(v!.html).toContain('disabled checked');
		expect('toggleTask' in mdwiki).toBe(false);
		expect('uploadForPage' in mdwiki).toBe(false);
	});
});

describe('search', () => {
	it('ranks title hits first and reports the matching section with an anchor', async () => {
		const { mdwiki } = await setup();
		const r = mdwiki.search('duplicate heading');
		expect(r.results[0]).toMatchObject({ path: 'Server/Alpha', folder: 'Server', section: { heading: 'Setup Steps', slug: 'setup-steps-1' } });
		expect(r.results[0].snippet.toLowerCase()).toContain('duplicate heading');
		expect(mdwiki.search('alpha').results[0].path).toBe('Server/Alpha');
	});

	it('supports "phrases", #tag and in:folder filters', async () => {
		const { mdwiki } = await setup();
		expect(mdwiki.search('"start things"').results.map((h) => h.path)).toEqual(['Server/Alpha']);
		expect(mdwiki.search('"things start"').results).toEqual([]);
		const tagged = mdwiki.search('#infra').results.map((h) => h.path);
		expect(tagged).toEqual(['Server/Alpha']);
		const inFolder = mdwiki.search('in:Server').results.map((h) => h.path).sort();
		expect(inFolder).toEqual(['Server/Alpha', 'Server/Beta']);
		expect(mdwiki.search('things in:Notes').results).toEqual([]);
		expect(mdwiki.search('#server things').results.map((h) => h.path)).toEqual(['Server/Alpha']);
	});

	it('returns folder and tag facets over all matches', async () => {
		const { mdwiki } = await setup();
		const r = mdwiki.search('server', 1);
		expect(r.total).toBeGreaterThan(1);
		expect(r.results).toHaveLength(1);
		expect(r.facets.folders.find((f) => f.name === 'Server')?.count).toBeGreaterThan(1);
		expect(r.facets.tags.map((t) => t.name)).toContain('server');
	});

	it('falls back to fuzzy title matching and hides Library', async () => {
		const { mdwiki } = await setup();
		expect(mdwiki.search('syntx').results.map((h) => h.path)).toContain('Syntax');
		expect(mdwiki.search('hidden library page').results).toEqual([]);
	});
});
