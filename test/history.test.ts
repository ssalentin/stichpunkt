import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { parseDateValue } from '../src/lib/server/agent-manifest';
import { buildMcpServer } from '../src/lib/server/mcp';
import { makeMdwiki } from './helpers';

const read = async (mdwiki: Awaited<ReturnType<typeof makeMdwiki>>['mdwiki'], page: string) => (await mdwiki.readPage(page)).content;

describe('history', () => {
	it('keeps the previous content on every service write, newest first', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Notes/Log', 'one\n');
		const list = await mdwiki.history('Notes/Log');
		expect(list.total).toBe(0); // the first write creates the page, nothing to keep
		await mdwiki.writePage('Notes/Log', 'two\n');
		const after = await mdwiki.history('Notes/Log');
		expect(after.path).toBe('Notes/Log');
		expect(after.total).toBe(1);
		expect(after.revisions[0]).toMatchObject({ size: 4 });
		expect(typeof after.revisions[0].hash).toBe('string');
		expect(after.revisions[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		await mdwiki.writePage('Notes/Log', 'three\n');
		const more = await mdwiki.history('Notes/Log', 1);
		expect(more.total).toBe(2);
		expect(more.revisions).toHaveLength(1); // limit only trims the list
	});

	it('records appends with the previous content', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Notes/Append', 'base\n');
		await mdwiki.appendToPage('Notes/Append', 'more');
		const revs = (await mdwiki.history('Notes/Append')).revisions;
		expect(revs).toHaveLength(1);
		const diff = await mdwiki.diff('Notes/Append');
		expect(diff.since.hash).toBe(revs[0].hash);
		expect(diff.diff).toContain('+more');
	});

	it('records a deletion with a marker', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Notes/Gone', 'bye\n');
		await mdwiki.deletePage('Notes/Gone');
		const list = await mdwiki.history('Notes/Gone');
		expect(list.revisions[0].marker).toBe('deleted');
	});

	it('records a move with "moved to" and the backlink rewrites', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Notes/Contact', 'contact\n');
		const linkHash = (await mdwiki.readPage('Notes/Overview').catch(() => null))?.hash;
		expect(linkHash).toBeUndefined();
		await mdwiki.writePage('Notes/Overview', 'see [[Notes/Contact]]\n');
		await mdwiki.movePage('Notes/Contact', 'Archive/Contact');
		const moved = await mdwiki.history('Notes/Contact');
		expect(moved.revisions[0].marker).toBe('moved to Archive/Contact');
		const rewritten = await mdwiki.history('Notes/Overview');
		expect(rewritten.total).toBe(1);
		const diff = await mdwiki.diff('Notes/Overview');
		expect(diff.diff).toContain('-see [[Notes/Contact]]');
		expect(diff.diff).toContain('+see [[Archive/Contact]]');
	});

	it('does not record direct file edits', async () => {
		const { mdwiki, dir } = await makeMdwiki();
		await mdwiki.writePage('Notes/External', 'v1\n');
		fs.writeFileSync(path.join(dir, 'Notes/External.md'), 'v2 by hand\n');
		await mdwiki.index.refresh();
		expect((await mdwiki.history('Notes/External')).total).toBe(0);
	});

	it('prunes old revisions to HISTORY_KEEP', async () => {
		const { mdwiki } = await makeMdwiki({ env: { HISTORY_KEEP: '3' } });
		await mdwiki.writePage('Notes/Keep', 'v0\n');
		for (let i = 1; i <= 5; i++) await mdwiki.writePage('Notes/Keep', `v${i}\n`);
		const list = await mdwiki.history('Notes/Keep');
		expect(list.total).toBe(3);
		// the newest revisions are the ones between v2 and v5
		const diffs = await Promise.all(list.revisions.map((r) => mdwiki.diff('Notes/Keep', r.hash)));
		expect(diffs.map((d) => d.diff.split('\n').find((l) => /^-[^-]/.test(l)))).toEqual(['-v4', '-v3', '-v2']);
	});

	it('keeps everything with HISTORY_KEEP=0', async () => {
		const { mdwiki } = await makeMdwiki({ env: { HISTORY_KEEP: '0' } });
		await mdwiki.writePage('Notes/All', 'v0\n');
		for (let i = 1; i <= 4; i++) await mdwiki.writePage('Notes/All', `v${i}\n`);
		expect((await mdwiki.history('Notes/All')).total).toBe(4);
	});

	it('keeps the history out of the page index and out of every read path', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Notes/Secret', 'v1\n');
		await mdwiki.writePage('Notes/Secret', 'v2\n');
		expect(fs.readdirSync(path.join(mdwiki.store.root, '.history', 'Notes', 'Secret')).length).toBeGreaterThan(0);
		expect(mdwiki.listPages().map((p) => p.path)).not.toContain('.history/Notes/Secret');
		expect(mdwiki.index.list().map((p) => p.path)).not.toContain('.history/Notes/Secret');
		const entries = fs.readdirSync(path.join(mdwiki.store.root, '.history', 'Notes', 'Secret'));
		const id = entries.find((name) => name.endsWith('.md'))!.slice(0, -3);
		for (const bad of [`.history/Notes/Secret/${id}`, '.history/Notes/Secret', '.history/Notes']) {
			await expect(mdwiki.readPage(bad)).rejects.toMatchObject({ status: 400 });
			await expect(mdwiki.deletePage(bad)).rejects.toMatchObject({ status: 400 });
			await expect(mdwiki.uploadAttachment(`${bad}.md`, Buffer.from('x'))).rejects.toMatchObject({ status: 400 });
		}
		const [a, b] = InMemoryTransport.createLinkedPair();
		await buildMcpServer(mdwiki).connect(b);
		const client = new Client({ name: 'test', version: '1' });
		await client.connect(a);
		const r = await client.callTool({ name: 'read_page', arguments: { path: `.history/Notes/Secret/${id}` } });
		expect(r.isError).toBe(true);
	});
});

describe('diff', () => {
	it('produces a unified diff against the last revision', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Notes/Diff', 'line one\nline two\nline three\n');
		await mdwiki.writePage('Notes/Diff', 'line one\nline TWO\nline three\n');
		const res = await mdwiki.diff('Notes/Diff');
		expect(res.diff).toMatch(/^--- Notes\/Diff @ \d{8}T\d+Z-[0-9a-f]{12}\n\+\+\+ Notes\/Diff \(current\)\n@@ -1,3 \+1,3 @@\n line one\n-line two\n\+line TWO\n line three\n$/);
		expect(res.added).toBe(1);
		expect(res.removed).toBe(1);
		expect(res.current.exists).toBe(true);
	});

	it('accepts a revision id, a hash prefix and an ISO time', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Notes/Diff2', 'a\n');
		await mdwiki.writePage('Notes/Diff2', 'b\n');
		const first = (await mdwiki.history('Notes/Diff2')).revisions[0];
		await mdwiki.writePage('Notes/Diff2', 'c\n');
		expect((await mdwiki.diff('Notes/Diff2', first.id)).diff).toContain('-a');
		expect((await mdwiki.diff('Notes/Diff2', first.hash.slice(0, 6))).diff).toContain('-a');
		expect((await mdwiki.diff('Notes/Diff2', first.at)).diff).toContain('-a');
		await expect(mdwiki.diff('Notes/Diff2', 'no-such-revision')).rejects.toMatchObject({ status: 404, code: 'revision_not_found' });
		await expect(mdwiki.diff('Notes/WithoutHistory')).rejects.toMatchObject({ status: 404, code: 'no_history' });
	});

	it('shows the page as deleted when it no longer exists', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Notes/Removed', 'only line\n');
		await mdwiki.deletePage('Notes/Removed');
		const res = await mdwiki.diff('Notes/Removed');
		expect(res.current).toEqual({ exists: false, hash: null });
		expect(res.diff).toContain('-only line');
	});

	it('is exposed over MCP', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Notes/Mcp', 'x\n');
		await mdwiki.writePage('Notes/Mcp', 'y\n');
		const [a, b] = InMemoryTransport.createLinkedPair();
		await buildMcpServer(mdwiki).connect(b);
		const client = new Client({ name: 'test', version: '1' });
		await client.connect(a);
		const text = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
		expect(text(await client.callTool({ name: 'history', arguments: { path: 'Notes/Mcp' } })).total).toBe(1);
		expect(text(await client.callTool({ name: 'diff', arguments: { path: 'Notes/Mcp' } })).diff).toContain('+y');
	});
});

describe('check_manifest', () => {
	const write = (mdwiki: Awaited<ReturnType<typeof makeMdwiki>>['mdwiki'], body: string) => mdwiki.writePage('MANIFEST', body);

	it('is ok without a manifest and for a manifest that fits the space', async () => {
		const { mdwiki } = await makeMdwiki();
		expect(await mdwiki.checkManifest()).toEqual({ ok: true, issues: [] });
		await write(mdwiki, '---\nmanifest: 1\nsummary: s\nfolders:\n  Server: { owner: "alice" }\n  Notes: {}\npages:\n  allowed_tags: [server]\n---\n');
		expect(await mdwiki.checkManifest()).toEqual({ ok: true, issues: [] });
	});

	it('reports schema errors with a path', async () => {
		const { mdwiki, dir } = await makeMdwiki();
		// an invalid manifest is rejected by the write path, so place it on disk
		for (const content of ['---\nmanifest: 1\nsummary: s\nchecs: [secrets]\n---\n', '---\nmanifest: 1\nsummary: s\nchecks: [nope]\n---\n']) {
			fs.writeFileSync(path.join(dir, 'MANIFEST.md'), content);
			await mdwiki.index.refresh();
			const bad = await mdwiki.checkManifest();
			expect(bad.ok).toBe(false);
			expect(bad.issues.length).toBeGreaterThan(0);
			expect(typeof bad.issues[0].path).toBe('string');
		}
	});

	it('reports allowed tags without a tag.define, missing folders and colliding keys', async () => {
		const { mdwiki } = await makeMdwiki();
		await write(
			mdwiki,
			'---\nmanifest: 1\nsummary: s\npages:\n  allowed_tags: [server, nowhere]\nfolders:\n  Server: {}\n  Ghost: {}\n  Notes: {}\n  "notes/": {}\n---\n'
		);
		const res = await mdwiki.checkManifest();
		expect(res.ok).toBe(false);
		expect(res.issues).toEqual(
			expect.arrayContaining([
				{ path: 'pages.allowed_tags', message: expect.stringContaining('nowhere') },
				{ path: 'folders.Ghost', message: expect.stringContaining('no page') },
				{ path: 'folders.notes/', message: expect.stringContaining('collides') }
			])
		);
	});

	it('is read-only and exposed over MCP', async () => {
		const { mdwiki } = await makeMdwiki();
		await write(mdwiki, '---\nmanifest: 1\nsummary: s\nfolders:\n  Ghost: {}\n---\n');
		const before = await read(mdwiki, 'MANIFEST');
		const [a, b] = InMemoryTransport.createLinkedPair();
		await buildMcpServer(mdwiki).connect(b);
		const client = new Client({ name: 'test', version: '1' });
		await client.connect(a);
		const result = await client.callTool({ name: 'check_manifest', arguments: {} });
		const body = JSON.parse((result.content as { text: string }[])[0].text);
		expect(body.ok).toBe(false);
		expect(body.issues[0].path).toBe('folders.Ghost');
		expect(await read(mdwiki, 'MANIFEST')).toBe(before);
	});
});

describe('parseDateValue', () => {
	it.each([
		['2026-10-28', '2026-10-28T00:00:00.000Z'],
		['2026-10-28T14:55:00Z', '2026-10-28T14:55:00.000Z'],
		['2026-10-28 14:55:00+02:00', '2026-10-28T12:55:00.000Z'],
		['28.10.2026', '2026-10-28T00:00:00.000Z'],
		['28.10.2026 14:55', '2026-10-28T14:55:00.000Z'],
		['updated: 2026-10-28', '2026-10-28T00:00:00.000Z']
	])('parses %s', (input, iso) => {
		expect(parseDateValue(input)?.toISOString()).toBe(iso);
	});

	it('uses an IANA zone when one is given', () => {
		expect(parseDateValue('28.10.2026 14:55 Europe/Berlin')?.toISOString()).toBe('2026-10-28T13:55:00.000Z');
		expect(parseDateValue('2026-07-01 12:00 Europe/Berlin')?.toISOString()).toBe('2026-07-01T10:00:00.000Z');
	});

	it.each(['', 'yesterday', '2026-02-31', '32.13.2026', '2026-10-28T25:00'])('rejects %j', (input) => {
		expect(parseDateValue(input)).toBeNull();
	});
});

describe('manifest checks', () => {
	const manifest = (checks: string, pages = '', folders = '') =>
		`---\nmanifest: 1\nsummary: s\nchecks: [${checks}]\n${pages}${folders}---\n`;

	it('warns about tags outside pages.allowed_tags only when the frontmatter check is on', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('MANIFEST', manifest('frontmatter', 'pages:\n  allowed_tags: [allowed, other]\n'));
		await expect(mdwiki.writePage('Notes/Tag', '---\ntags: [allowed]\n---\nx\n')).resolves.toMatchObject({ warnings: [] });
		const res = await mdwiki.writePage('Notes/Tag', '---\ntags: [strange]\n---\nx\n');
		expect(res.warnings).toMatchObject([{ rule: 'tag_not_allowed', message: expect.stringContaining('strange') }]);
		await mdwiki.writePage('MANIFEST', manifest('secrets', 'pages:\n  allowed_tags: [allowed]\n'));
		expect((await mdwiki.writePage('Notes/Tag', '---\ntags: [strange]\n---\nx\n')).warnings).toEqual([]);
	});

	it('warns about a folder owner only when an actor is named', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('MANIFEST', manifest('owner', '', 'folders:\n  Notes: { owner: "alice" }\n'));
		expect((await mdwiki.writePage('Notes/Owned', 'x\n', undefined, 'alice')).warnings).toEqual([]);
		expect((await mdwiki.writePage('Notes/Owned', 'x\n', undefined, 'bob')).warnings).toMatchObject([{ rule: 'owner_mismatch' }]);
		expect((await mdwiki.writePage('Notes/Owned', 'x\n')).warnings).toEqual([]);
		// root pages have no folder owner
		expect((await mdwiki.writePage('RootPage', 'x\n', undefined, 'bob')).warnings).toEqual([]);
	});

	it('warns about missing, unparseable and stale stand dates', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('MANIFEST', manifest('stand_age', 'pages:\n  stand_field: updated\n  stand_max_age_days: 30\n'));
		const stale = await mdwiki.validatePage('Notes/Age', '---\nupdated: 2020-01-01\n---\nx\n');
		expect(stale.warnings).toMatchObject([{ rule: 'stand_stale' }]);
		const missing = await mdwiki.validatePage('Notes/Age', '# no frontmatter\n');
		expect(missing.warnings).toMatchObject([{ rule: 'stand_missing' }]);
		const broken = await mdwiki.validatePage('Notes/Age', '---\nupdated: last week\n---\n');
		expect(broken.warnings).toMatchObject([{ rule: 'stand_unparseable' }]);
		const fresh = await mdwiki.validatePage('Notes/Age', `---\nupdated: ${new Date().toISOString()}\n---\n`);
		expect(fresh.warnings).toEqual([]);
	});

	it('warns when an actor is required and none was given', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('MANIFEST', manifest('', 'pages:\n  require_agent: true\n'));
		expect((await mdwiki.writePage('Notes/Actor', 'x\n')).warnings).toMatchObject([{ rule: 'missing_actor', message: 'actor unknown' }]);
		expect((await mdwiki.writePage('Notes/Actor', 'x\n', undefined, 'alice')).warnings).toEqual([]);
	});

	it('compares owner names trimmed and case-insensitively and reports them in the write response', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('MANIFEST', manifest('owner', '', 'folders:\n  Notes: { owner: "Alice" }\n'));
		const single = await mdwiki.writePage('Notes/Names', 'x\n', undefined, '  alice ');
		expect(single.warnings).toEqual([]);
		expect(single).toMatchObject({ actor: 'alice', owner: 'Alice', owner_ok: true });
		const other = await mdwiki.appendToPage('Notes/Names', 'more', 'bob');
		expect(other).toMatchObject({ actor: 'bob', owner: 'Alice', owner_ok: false });
		expect(other.warnings).toMatchObject([{ rule: 'owner_mismatch' }]);
		const batch = await mdwiki.writePages([{ path: 'Notes/Names', content: 'y\n' }], false, 'bob');
		expect(batch.written[0]).toMatchObject({ actor: 'bob', owner: 'Alice', owner_ok: false });
		const root = await mdwiki.writePage('Loose', 'x\n', undefined, 'bob');
		expect(root).toMatchObject({ actor: 'bob', owner: null, owner_ok: true });
	});

	it('uses "updated" and 90 days as defaults without explicit fields', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('MANIFEST', manifest('stand_age'));
		const res = await mdwiki.validatePage('Notes/Default', '---\nupdated: 2026-01-01\n---\n');
		expect(res.warnings).toMatchObject([{ rule: 'stand_stale', message: expect.stringContaining('90') }]);
	});

	it('reports the actor name to write_page over MCP', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('MANIFEST', manifest('owner', '', 'folders:\n  Notes: { owner: "alice" }\n'));
		const [a, b] = InMemoryTransport.createLinkedPair();
		await buildMcpServer(mdwiki).connect(b);
		const client = new Client({ name: 'test', version: '1' });
		await client.connect(a);
		const text = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
		const res = text(await client.callTool({ name: 'write_page', arguments: { path: 'Notes/ByMcp', content: 'x\n', agent: 'bob' } }));
		expect(res.warnings).toMatchObject([{ rule: 'owner_mismatch' }]);
	});
});
