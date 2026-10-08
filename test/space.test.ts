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
	it('resolves links by path, case, folder and unique basename; computes backlinks', async () => {
		const { mdwiki } = await setup();
		const back = mdwiki.getBacklinks('Server/Alpha').map((b) => b.path);
		expect(back).toEqual(expect.arrayContaining(['Server/Beta', 'index', 'Library/Hidden']));
		// [[alpha|...]] resolves case-insensitively to Server/Alpha
		expect(mdwiki.index.resolve('alpha', 'Server/Beta')).toBe('Server/Alpha');
		expect(mdwiki.index.resolve('Beta', 'Server/Alpha')).toBe('Server/Beta');
		expect(mdwiki.index.resolve('Does Not Exist', 'index')).toBeNull();
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
