import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { buildMcpServer } from '../src/lib/server/mcp';
import { scanLinks } from '../src/lib/server/links';
import { makeMdwiki } from './helpers';

const read = async (mdwiki: Awaited<ReturnType<typeof makeMdwiki>>['mdwiki'], page: string) => (await mdwiki.readPage(page)).content;
const exists = async (mdwiki: Awaited<ReturnType<typeof makeMdwiki>>['mdwiki'], page: string) => {
	try {
		await mdwiki.readPage(page);
		return true;
	} catch {
		return false;
	}
};

describe('scanLinks', () => {
	it('finds links with offsets and keeps code, embeds and aliases apart', () => {
		const raw = '# Title\n\n[[Eins|Alias]] and ![[Zwei#Teil]]\n\n`[[Inline]]`\n\n```ts\n[[Fence]]\n```\n\n[[#NurHeading]]\n';
		const links = scanLinks(raw);
		expect(links.map((l) => [l.target, l.embed, l.heading, l.alias])).toEqual([
			['Eins', false, undefined, 'Alias'],
			['Zwei', true, 'Teil', undefined],
			['', false, 'NurHeading', undefined]
		]);
		// rewriting the target offsets keeps the surrounding syntax intact
		const first = links[0];
		expect(raw.slice(first.start, first.end)).toBe('[[Eins|Alias]]');
		expect(raw.slice(first.targetStart, first.targetEnd)).toBe('Eins');
		expect(scanLinks('---\ntitle: [[Frontmatter]]\n---\n\n[[Body]]\n').map((l) => l.target)).toEqual(['Body']);
	});
});

describe('move_page', () => {
	it('dry_run reports the plan and writes nothing', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Notes/Rolodex', '# Rolodex\n');
		await mdwiki.writePage('Notes/Page', 'Siehe [[Notes/Rolodex]].\n');
		const plan = await mdwiki.movePage('Notes/Rolodex', 'Archive/Rolodex', true);
		expect(plan).toMatchObject({ from: 'Notes/Rolodex', to: 'Archive/Rolodex', dry_run: true, moved: false });
		expect(plan.rewritten).toEqual([{ path: 'Notes/Page', links: 1 }]);
		expect(await exists(mdwiki, 'Notes/Rolodex')).toBe(true);
		expect(await exists(mdwiki, 'Archive/Rolodex')).toBe(false);
		expect(await read(mdwiki, 'Notes/Page')).toBe('Siehe [[Notes/Rolodex]].\n');
	});

	it('preserves alias, heading and embed markers', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Notes/Rolodex', '# Rolodex\n\n## Contact\n');
		await mdwiki.writePage('Notes/Page', '[[Notes/Rolodex#Contact|Rolodex list]]\n\n![[Notes/Rolodex]]\n');
		const res = await mdwiki.movePage('Notes/Rolodex', 'Archive/Rolodex');
		expect(res.moved).toBe(true);
		expect(await read(mdwiki, 'Notes/Page')).toBe('[[Archive/Rolodex#Contact|Rolodex list]]\n\n![[Archive/Rolodex]]\n');
		const moved = await read(mdwiki, 'Archive/Rolodex');
		expect(moved).toContain('## Contact');
		expect(await exists(mdwiki, 'Notes/Rolodex')).toBe(false);
	});

	it('leaves a unique-basename link alone', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Notes/Rolodex', '# Rolodex\n');
		await mdwiki.writePage('Notes/Page', 'Siehe [[Rolodex]].\n');
		const res = await mdwiki.movePage('Notes/Rolodex', 'Archive/Rolodex');
		expect(res.rewritten).toEqual([]);
		expect(await read(mdwiki, 'Notes/Page')).toBe('Siehe [[Rolodex]].\n');
		// and it now resolves to the new path
		expect(mdwiki.index.resolve('Rolodex', 'Notes/Page')).toBe('Archive/Rolodex');
	});

	it('rewrites a relative link from another folder when the basename is ambiguous', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Notes/Rolodex', '# Rolodex\n');
		await mdwiki.writePage('Archive/Rolodex', '# Other Rolodex\n');
		await mdwiki.writePage('Notes/Item', 'Siehe [[Rolodex]].\n');
		const res = await mdwiki.movePage('Notes/Rolodex', 'New/Rolodex');
		expect(res.rewritten).toEqual([{ path: 'Notes/Item', links: 1 }]);
		expect(await read(mdwiki, 'Notes/Item')).toBe('Siehe [[New/Rolodex]].\n');
	});

	it('rewrites a full path from another folder and links inside the moved page', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Notes/Rolodex', 'Self: [[Notes/Rolodex]]\n\nSiehe [[Notes/Rolodex#Contact]].\n');
		await mdwiki.writePage('Other/Page', '[[Notes/Rolodex]]\n');
		await mdwiki.movePage('Notes/Rolodex', 'Archive/Contacts');
		expect(await read(mdwiki, 'Other/Page')).toBe('[[Archive/Contacts]]\n');
		const moved = await read(mdwiki, 'Archive/Contacts');
		expect(moved).toContain('Self: [[Archive/Contacts]]');
		expect(moved).toContain('Siehe [[Archive/Contacts#Contact]].');
	});

	it('does not touch code fences or inline code', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Notes/Rolodex', '# Rolodex\n');
		const content = '[[Notes/Rolodex]]\n\n`[[Notes/Rolodex]]`\n\n```md\n[[Notes/Rolodex]]\n```\n';
		await mdwiki.writePage('Notes/Page', content);
		await mdwiki.movePage('Notes/Rolodex', 'Archive/Rolodex');
		expect(await read(mdwiki, 'Notes/Page')).toBe('[[Archive/Rolodex]]\n\n`[[Notes/Rolodex]]`\n\n```md\n[[Notes/Rolodex]]\n```\n');
	});

	it('reports an ambiguous basename that never resolved as unresolved', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Notes/Rolodex', '# Rolodex\n');
		await mdwiki.writePage('Personal/Rolodex', '# Personal\n');
		await mdwiki.writePage('RolodexRef', 'Siehe [[Rolodex]].\n');
		const res = await mdwiki.movePage('Notes/Rolodex', 'Archive/Rolodex-Old');
		expect(res.unresolved).toEqual([{ path: 'RolodexRef', target: 'Rolodex', reason: 'ambiguous_basename' }]);
		expect(await read(mdwiki, 'RolodexRef')).toBe('Siehe [[Rolodex]].\n');
	});

	it('refuses an existing target, the same path and a missing source', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('A/Source', 'content\n');
		await mdwiki.writePage('B/Target', 'occupied\n');
		await expect(mdwiki.movePage('A/Source', 'B/Target')).rejects.toMatchObject({ status: 409, code: 'target_exists' });
		await expect(mdwiki.movePage('A/Source', 'A/Source')).rejects.toMatchObject({ status: 400 });
		await expect(mdwiki.movePage('A/Missing', 'A/Neu')).rejects.toMatchObject({ status: 404 });
		expect(await read(mdwiki, 'A/Source')).toBe('content\n');
		expect(await read(mdwiki, 'B/Target')).toBe('occupied\n');
	});

	it('overwrites an existing target only with overwrite and reports the previous hash', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Notes/Source', 'moved content\n');
		await mdwiki.writePage('Notes/Target', 'old target\n');
		const before = await mdwiki.readPage('Notes/Target');
		const dry = await mdwiki.movePage('Notes/Source', 'Notes/Target', true, undefined, true);
		expect(dry).toMatchObject({ moved: false, overwrite: true, previous_hash: before.hash, base_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
		expect(await read(mdwiki, 'Notes/Target')).toBe('old target\n');
		const res = await mdwiki.movePage('Notes/Source', 'Notes/Target', false, undefined, true);
		expect(res).toMatchObject({ moved: true, overwrite: true, previous_hash: before.hash });
		expect(res.base_hash).toBe((await mdwiki.readPage('Notes/Target')).hash);
		expect(await read(mdwiki, 'Notes/Target')).toBe('moved content\n');
		expect(await exists(mdwiki, 'Notes/Source')).toBe(false);
		const history = await mdwiki.history('Notes/Target');
		expect(history.revisions.map((r) => r.marker)).toEqual(
			expect.arrayContaining(['overwritten by move from Notes/Source', 'moved from Notes/Source'])
		);
	});

	it('merges both histories on an overwrite move without duplicate versions', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Notes/Source', 's0\n');
		await mdwiki.writePage('Notes/Source', 's1\n');
		await mdwiki.writePage('Notes/Target', 't0\n');
		await mdwiki.writePage('Notes/Target', 't1\n');
		await mdwiki.movePage('Notes/Source', 'Notes/Target', false, undefined, true);
		const versions = (await mdwiki.history('Notes/Target')).revisions.map((r) => r.version);
		expect(new Set(versions).size).toBe(versions.length);
		expect(versions.sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
	});

	it('moves the history with the page and leaves _attachments alone', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Notes/Source', 'v1\n');
		await mdwiki.writePage('Notes/Source', 'v2\n');
		await mdwiki.uploadAttachment('Notes/_attachments/pic.png', Buffer.from([137, 80, 78, 71]));
		const root = mdwiki.store.root;
		expect((await mdwiki.history('Notes/Source')).total).toBe(1);
		await mdwiki.movePage('Notes/Source', 'Archive/Source');
		expect(fs.existsSync(path.join(root, 'Notes/_attachments/pic.png'))).toBe(true);
		expect(fs.readdirSync(path.join(root, '.history', 'Notes', 'Source'))).toEqual([]);
		const moved = await mdwiki.history('Archive/Source');
		expect(moved.revisions.map((r) => r.version)).toEqual([2, 1]);
		expect(moved.revisions[0].marker).toBe('moved from Notes/Source');
	});

	it('is exposed as an MCP tool', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Notes/Rolodex', '# Rolodex\n');
		const [a, b] = InMemoryTransport.createLinkedPair();
		await buildMcpServer(mdwiki).connect(b);
		const client = new Client({ name: 'test', version: '1' });
		await client.connect(a);
		const r = await client.callTool({ name: 'move_page', arguments: { from: 'Notes/Rolodex', to: 'Archive/Rolodex', dry_run: true } });
		const body = JSON.parse((r.content as { text: string }[])[0].text);
		expect(body).toMatchObject({ from: 'Notes/Rolodex', to: 'Archive/Rolodex', dry_run: true });
	});
});

describe('check_links', () => {
	it('reports dead links, ambiguous basenames and bad anchors', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('A/Dup', '# Dup A\n');
		await mdwiki.writePage('B/Dup', '# Dup B\n');
		await mdwiki.writePage('Target', '# Ziel\n\n## Real Section\n');
		await mdwiki.writePage('Source', 'Zeile 1\n[[Missing]]\n[[Dup]]\n[[Target#No Such Section]]\n[[Target#Real Section]]\n');
		const res = await mdwiki.checkLinks('Source');
		expect(res.dead).toEqual(
			expect.arrayContaining([
				{ path: 'Source', line: 2, target: 'Missing' },
				{ path: 'Source', line: 3, target: 'Dup' }
			])
		);
		expect(res.ambiguous).toEqual([{ path: 'Source', target: 'Dup', candidates: ['A/Dup', 'B/Dup'] }]);
		expect(res.anchors).toEqual([{ path: 'Source', target: 'Target', heading: 'No Such Section' }]);
		expect(res.counts.dead).toBe(2);
		expect(res.counts.anchors).toBe(1);
	});

	it('marks pages without incoming links, including root pages', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Island/Page', 'kein Link hierher\n');
		await mdwiki.writePage('Root', 'auch niemand\n');
		await mdwiki.writePage('Linked', 'nur Text\n');
		await mdwiki.writePage('Linker', '[[Linked]]\n');
		const res = await mdwiki.checkLinks();
		expect(res.orphans).toEqual(
			expect.arrayContaining([
				{ path: 'Island/Page', root: false },
				{ path: 'Root', root: true }
			])
		);
		expect(res.orphans.map((o) => o.path)).not.toContain('Linked');
	});

	it('skips hidden Library pages unless include_working is set', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Library/Werkstatt', 'Arbeitsnotiz [[Nirgends]]\n');
		expect((await mdwiki.checkLinks('Library')).dead).toEqual([]);
		const withWorking = await mdwiki.checkLinks('Library', true);
		expect(withWorking.dead.map((d) => d.target)).toEqual(['Nirgends']);
	});

	it('scopes to one page or folder', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Area/A', '[[Missing]]\n');
		await mdwiki.writePage('Anders/B', '[[Also Missing]]\n');
		const res = await mdwiki.checkLinks('Area');
		expect(res.dead.map((d) => d.path)).toEqual(['Area/A']);
	});

	it('is read-only and registered as a tool', async () => {
		const { mdwiki } = await makeMdwiki();
		const before = await read(mdwiki, 'index');
		await mdwiki.checkLinks();
		expect(await read(mdwiki, 'index')).toBe(before);
		const [a, b] = InMemoryTransport.createLinkedPair();
		await buildMcpServer(mdwiki).connect(b);
		const client = new Client({ name: 'test', version: '1' });
		await client.connect(a);
		const r = await client.callTool({ name: 'check_links', arguments: {} });
		const body = JSON.parse((r.content as { text: string }[])[0].text);
		expect(body.counts.pages).toBeGreaterThan(0);
	});
});

describe('write_pages', () => {
	it('writes several pages and rebuilds the index once', async () => {
		const { mdwiki } = await makeMdwiki();
		const res = await mdwiki.writePages([
			{ path: 'Batch/Eins', content: 'Eins [[Batch/Zwei]]\n' },
			{ path: 'Batch/Zwei', content: 'Zwei\n' }
		]);
		expect(res.dry_run).toBe(false);
		expect(res.written.map((w: { path: string }) => w.path)).toEqual(['Batch/Eins', 'Batch/Zwei']);
		expect(await read(mdwiki, 'Batch/Zwei')).toBe('Zwei\n');
		expect(mdwiki.index.resolve('Batch/Zwei', 'Batch/Eins')).toBe('Batch/Zwei');
	});

	it('rejects the whole batch on one stale base_hash and changes nothing', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Batch/A', 'alt\n');
		const oldHash = (await mdwiki.readPage('Batch/A')).hash;
		await mdwiki.writePage('Batch/A', 'inzwischen geändert\n');
		await expect(
			mdwiki.writePages([
				{ path: 'Batch/A', content: 'neu\n', base_hash: oldHash },
				{ path: 'Batch/B', content: 'auch neu\n' }
			])
		).rejects.toMatchObject({ status: 409, code: 'conflict' });
		expect(await read(mdwiki, 'Batch/A')).toBe('inzwischen geändert\n');
		expect(await exists(mdwiki, 'Batch/B')).toBe(false);
	});

	it('rejects duplicate paths, including the .md spelling', async () => {
		const { mdwiki } = await makeMdwiki();
		await expect(mdwiki.writePages([{ path: 'X', content: 'a' }, { path: 'X.md', content: 'b' }])).rejects.toMatchObject({
			status: 400,
			code: 'duplicate_path'
		});
	});

	it('dry_run returns the hash and the warnings per page and writes nothing', async () => {
		const { mdwiki } = await makeMdwiki();
		const res = await mdwiki.writePages([{ path: 'Batch/Dry', content: 'just a plan\n' }], true);
		expect(res.dry_run).toBe(true);
		expect(res.written[0]).toMatchObject({
			path: 'Batch/Dry',
			hash: expect.stringMatching(/^[0-9a-f]{64}$/),
			warnings: [],
			actor: null,
			owner: null,
			owner_ok: true
		});
		expect(await exists(mdwiki, 'Batch/Dry')).toBe(false);
	});

	it('rolls back already written files when the disk fails', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Batch/A', 'vorher\n');
		const store = mdwiki.store as unknown as { write: (...args: unknown[]) => Promise<unknown> };
		const original = store.write.bind(mdwiki.store);
		store.write = async (...args: unknown[]) => {
			if (String(args[0]).includes('Batch/B')) throw new Error('disk full');
			return original(...args);
		};
		try {
			await expect(
				mdwiki.writePages([
					{ path: 'Batch/A', content: 'nachher\n' },
					{ path: 'Batch/B', content: 'neu\n' }
				])
			).rejects.toMatchObject({ status: 500, code: 'write_failed', details: { rolled_back: true } });
		} finally {
			store.write = original;
		}
		expect(await read(mdwiki, 'Batch/A')).toBe('vorher\n');
		expect(await exists(mdwiki, 'Batch/B')).toBe(false);
	});

	it('reports manifest warnings per page, including dead links when the links check is active', async () => {
		const { mdwiki } = await makeMdwiki();
		const rules = '---\nmanifest: 1\nsummary: s\nchecks: [links]\n---\n';
		await mdwiki.writePage('MANIFEST', rules);
		const res = await mdwiki.writePages([
			{ path: 'Batch/Good', content: '[[index]]\n' },
			{ path: 'Batch/Dead', content: '[[Missing Target]]\n' }
		]);
		expect(res.written[0].warnings).toEqual([]);
		expect(res.written[1].warnings).toMatchObject([{ rule: 'dead_link', line: 1, message: expect.stringContaining('Missing Target') }]);
		expect(await read(mdwiki, 'Batch/Dead')).toBe('[[Missing Target]]\n');
	});

	it('is exposed as an MCP tool', async () => {
		const { mdwiki } = await makeMdwiki();
		const [a, b] = InMemoryTransport.createLinkedPair();
		await buildMcpServer(mdwiki).connect(b);
		const client = new Client({ name: 'test', version: '1' });
		await client.connect(a);
		const r = await client.callTool({
			name: 'write_pages',
			arguments: { pages: [{ path: 'Mcp/Batch', content: 'hi\n' }], dry_run: true }
		});
		const body = JSON.parse((r.content as { text: string }[])[0].text);
		expect(body).toMatchObject({ dry_run: true, written: [{ path: 'Mcp/Batch' }] });
	});
});
