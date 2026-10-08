import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeFolio } from './helpers';

const open: { stop(): void }[] = [];
afterEach(() => open.splice(0).forEach((f) => f.stop()));
async function setup(opts?: Parameters<typeof makeFolio>[0]) {
	const r = await makeFolio(opts);
	open.push(r.folio);
	return r;
}

describe('index', () => {
	it('resolves links by path, case, folder and unique basename; computes backlinks', async () => {
		const { folio } = await setup();
		const back = folio.getBacklinks('Server/Alpha').map((b) => b.path);
		expect(back).toEqual(expect.arrayContaining(['Server/Beta', 'index', 'Library/Hidden']));
		// [[alpha|...]] resolves case-insensitively to Server/Alpha
		expect(folio.index.resolve('alpha', 'Server/Beta')).toBe('Server/Alpha');
		expect(folio.index.resolve('Beta', 'Server/Alpha')).toBe('Server/Beta');
		expect(folio.index.resolve('Does Not Exist', 'index')).toBeNull();
	});

	it('collects frontmatter and inline tags and hides Library', async () => {
		const { folio } = await setup();
		const tags = Object.fromEntries(folio.listTags().map((t) => [t.name, t.count]));
		expect(tags.server).toBe(3);
		expect(tags['alpha-tag']).toBe(1);
		expect(tags.infra).toBe(1);
		expect(folio.listPages().map((p) => p.path)).not.toContain('Library/Hidden');
		expect(folio.listPages('Library').map((p) => p.path)).toContain('Library/Hidden');
		expect(folio.pagesByTag('server').map((p) => p.path)).toEqual(['Server', 'Server/Alpha', 'Server/Beta']);
	});

	it('appends "Pages tagged" lists via CONFIG tagPage mapping and name match', async () => {
		const { folio } = await setup();
		const server = await folio.renderPage('Server');
		expect(server!.tagLists.map((l) => l.tag)).toEqual(['server']);
		expect(server!.tagLists[0].pages.map((p) => p.path)).toEqual(['Server/Alpha', 'Server/Beta']);
		const garten = await folio.renderPage('Notes/Garten');
		expect(garten!.tagLists.map((l) => l.tag)).toEqual(['garten']);
		expect(garten!.tagLists[0].pages.map((p) => p.path)).toEqual(['index']);
	});

	it('searches full text with snippets, titles first', async () => {
		const { folio } = await setup();
		const hits = folio.search('zebrafish');
		expect(hits.map((h) => h.path)).toEqual(['Server/Beta']);
		expect(hits[0].snippet).toContain('zebrafish-needle');
		expect(folio.search('beta')[0].path).toBe('Server/Beta');
		expect(folio.search('print')).toEqual([]); // inert Lua is not indexed
	});

	it('renders unique heading slugs and keeps frontmatter out of the body', async () => {
		const { folio } = await setup();
		const v = await folio.renderPage('Server/Alpha');
		expect(v!.headings.map((h) => h.slug)).toEqual(['alpha', 'setup-steps', 'setup-steps-1']);
		expect(v!.html).not.toContain('2026-10-01');
	});
});

describe('external changes (mtime poll)', () => {
	it('shows a file written outside the app in search and backlinks after one poll cycle', async () => {
		const { folio, dir } = await setup({ poll: 100 });
		expect(folio.search('quokka-marker')).toEqual([]);
		fs.writeFileSync(path.join(dir, 'External.md'), 'quokka-marker links to [[Server/Beta]]\n');
		await new Promise((r) => setTimeout(r, 450));
		expect(folio.search('quokka-marker').map((h) => h.path)).toEqual(['External']);
		expect(folio.getBacklinks('Server/Beta').map((b) => b.path)).toContain('External');
		// modification and deletion are picked up as well
		fs.writeFileSync(path.join(dir, 'External.md'), 'axolotl-marker\n');
		await new Promise((r) => setTimeout(r, 450));
		expect(folio.search('quokka-marker')).toEqual([]);
		expect(folio.search('axolotl-marker')).toHaveLength(1);
		fs.rmSync(path.join(dir, 'External.md'));
		await new Promise((r) => setTimeout(r, 450));
		expect(folio.search('axolotl-marker')).toEqual([]);
	});
});

describe('tasks', () => {
	it('toggles a checkbox on the right line and writes it back to the file', async () => {
		const { folio, dir } = await setup();
		const before = await folio.readPage('Server/Beta');
		const line = before.content.split('\n').findIndex((l) => l.includes('open task') && !l.includes('nested'));
		const res = await folio.toggleTask('Server/Beta', line, before.hash);
		expect(res.checked).toBe(true);
		expect(fs.readFileSync(path.join(dir, 'Server/Beta.md'), 'utf8')).toContain('- [x] open task');
		await expect(folio.toggleTask('Server/Beta', line, before.hash)).rejects.toMatchObject({ status: 409 });
	});
});
