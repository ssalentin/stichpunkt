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
		const hits = mdwiki.search('zebrafish');
		expect(hits.map((h) => h.path)).toEqual(['Server/Beta']);
		expect(hits[0].snippet).toContain('zebrafish-needle');
		expect(mdwiki.search('beta')[0].path).toBe('Server/Beta');
		expect(mdwiki.search('print')).toEqual([]); // inert Lua is not indexed
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
		expect(mdwiki.search('quokka-marker')).toEqual([]);
		fs.writeFileSync(path.join(dir, 'External.md'), 'quokka-marker links to [[Server/Beta]]\n');
		await new Promise((r) => setTimeout(r, 450));
		expect(mdwiki.search('quokka-marker').map((h) => h.path)).toEqual(['External']);
		expect(mdwiki.getBacklinks('Server/Beta').map((b) => b.path)).toContain('External');
		// modification and deletion are picked up as well
		fs.writeFileSync(path.join(dir, 'External.md'), 'axolotl-marker\n');
		await new Promise((r) => setTimeout(r, 450));
		expect(mdwiki.search('quokka-marker')).toEqual([]);
		expect(mdwiki.search('axolotl-marker')).toHaveLength(1);
		fs.rmSync(path.join(dir, 'External.md'));
		await new Promise((r) => setTimeout(r, 450));
		expect(mdwiki.search('axolotl-marker')).toEqual([]);
	});
});

describe('tasks', () => {
	it('toggles a checkbox on the right line and writes it back to the file', async () => {
		const { mdwiki, dir } = await setup();
		const before = await mdwiki.readPage('Server/Beta');
		const line = before.content.split('\n').findIndex((l) => l.includes('open task') && !l.includes('nested'));
		const res = await mdwiki.toggleTask('Server/Beta', line, before.hash);
		expect(res.checked).toBe(true);
		expect(fs.readFileSync(path.join(dir, 'Server/Beta.md'), 'utf8')).toContain('- [x] open task');
		await expect(mdwiki.toggleTask('Server/Beta', line, before.hash)).rejects.toMatchObject({ status: 409 });
	});
});
