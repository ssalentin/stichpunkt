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
		await mdwiki.writePage('Familie/Rolodex', '# Rolodex\n');
		await mdwiki.writePage('Notizen', 'Siehe [[Familie/Rolodex]].\n');
		const plan = await mdwiki.movePage('Familie/Rolodex', 'Archiv/Rolodex', true);
		expect(plan).toMatchObject({ from: 'Familie/Rolodex', to: 'Archiv/Rolodex', dry_run: true, moved: false });
		expect(plan.rewritten).toEqual([{ path: 'Notizen', links: 1 }]);
		expect(await exists(mdwiki, 'Familie/Rolodex')).toBe(true);
		expect(await exists(mdwiki, 'Archiv/Rolodex')).toBe(false);
		expect(await read(mdwiki, 'Notizen')).toBe('Siehe [[Familie/Rolodex]].\n');
	});

	it('preserves alias, heading and embed markers', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Familie/Rolodex', '# Rolodex\n\n## Kontakt\n');
		await mdwiki.writePage('Notizen', '[[Familie/Rolodex#Kontakt|Rolodex-Liste]]\n\n![[Familie/Rolodex]]\n');
		const res = await mdwiki.movePage('Familie/Rolodex', 'Archiv/Rolodex');
		expect(res.moved).toBe(true);
		expect(await read(mdwiki, 'Notizen')).toBe('[[Archiv/Rolodex#Kontakt|Rolodex-Liste]]\n\n![[Archiv/Rolodex]]\n');
		const moved = await read(mdwiki, 'Archiv/Rolodex');
		expect(moved).toContain('## Kontakt');
		expect(await exists(mdwiki, 'Familie/Rolodex')).toBe(false);
	});

	it('leaves a unique-basename link alone', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Familie/Rolodex', '# Rolodex\n');
		await mdwiki.writePage('Notizen', 'Siehe [[Rolodex]].\n');
		const res = await mdwiki.movePage('Familie/Rolodex', 'Archiv/Rolodex');
		expect(res.rewritten).toEqual([]);
		expect(await read(mdwiki, 'Notizen')).toBe('Siehe [[Rolodex]].\n');
		// and it now resolves to the new path
		expect(mdwiki.index.resolve('Rolodex', 'Notizen')).toBe('Archiv/Rolodex');
	});

	it('rewrites a relative link from another folder when the basename is ambiguous', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Familie/Rolodex', '# Rolodex\n');
		await mdwiki.writePage('Archiv/Rolodex', '# Anderer Rolodex\n');
		await mdwiki.writePage('Familie/Notiz', 'Siehe [[Rolodex]].\n');
		const res = await mdwiki.movePage('Familie/Rolodex', 'Neu/Rolodex');
		expect(res.rewritten).toEqual([{ path: 'Familie/Notiz', links: 1 }]);
		expect(await read(mdwiki, 'Familie/Notiz')).toBe('Siehe [[Neu/Rolodex]].\n');
	});

	it('rewrites a full path from another folder and links inside the moved page', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Familie/Rolodex', 'Selbst: [[Familie/Rolodex]]\n\nSiehe [[Familie/Rolodex#Kontakt]].\n');
		await mdwiki.writePage('Andere/Seite', '[[Familie/Rolodex]]\n');
		await mdwiki.movePage('Familie/Rolodex', 'Archiv/Kontakte');
		expect(await read(mdwiki, 'Andere/Seite')).toBe('[[Archiv/Kontakte]]\n');
		const moved = await read(mdwiki, 'Archiv/Kontakte');
		expect(moved).toContain('Selbst: [[Archiv/Kontakte]]');
		expect(moved).toContain('Siehe [[Archiv/Kontakte#Kontakt]].');
	});

	it('does not touch code fences or inline code', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Familie/Rolodex', '# Rolodex\n');
		const content = '[[Familie/Rolodex]]\n\n`[[Familie/Rolodex]]`\n\n```md\n[[Familie/Rolodex]]\n```\n';
		await mdwiki.writePage('Notizen', content);
		await mdwiki.movePage('Familie/Rolodex', 'Archiv/Rolodex');
		expect(await read(mdwiki, 'Notizen')).toBe('[[Archiv/Rolodex]]\n\n`[[Familie/Rolodex]]`\n\n```md\n[[Familie/Rolodex]]\n```\n');
	});

	it('reports an ambiguous basename that never resolved as unresolved', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Familie/Rolodex', '# Rolodex\n');
		await mdwiki.writePage('Privat/Rolodex', '# Privat\n');
		await mdwiki.writePage('Notizen', 'Siehe [[Rolodex]].\n');
		const res = await mdwiki.movePage('Familie/Rolodex', 'Archiv/Rolodex-Alt');
		expect(res.unresolved).toEqual([{ path: 'Notizen', target: 'Rolodex', reason: 'ambiguous_basename' }]);
		expect(await read(mdwiki, 'Notizen')).toBe('Siehe [[Rolodex]].\n');
	});

	it('refuses an existing target, the same path and a missing source', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('A/Quelle', 'in halt\n');
		await mdwiki.writePage('B/Ziel', 'belegt\n');
		await expect(mdwiki.movePage('A/Quelle', 'B/Ziel')).rejects.toMatchObject({ status: 409, code: 'target_exists' });
		await expect(mdwiki.movePage('A/Quelle', 'A/Quelle')).rejects.toMatchObject({ status: 400 });
		await expect(mdwiki.movePage('A/Fehlt', 'A/Neu')).rejects.toMatchObject({ status: 404 });
		expect(await read(mdwiki, 'A/Quelle')).toBe('in halt\n');
		expect(await read(mdwiki, 'B/Ziel')).toBe('belegt\n');
	});

	it('is exposed as an MCP tool', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Familie/Rolodex', '# Rolodex\n');
		const [a, b] = InMemoryTransport.createLinkedPair();
		await buildMcpServer(mdwiki).connect(b);
		const client = new Client({ name: 'test', version: '1' });
		await client.connect(a);
		const r = await client.callTool({ name: 'move_page', arguments: { from: 'Familie/Rolodex', to: 'Archiv/Rolodex', dry_run: true } });
		const body = JSON.parse((r.content as { text: string }[])[0].text);
		expect(body).toMatchObject({ from: 'Familie/Rolodex', to: 'Archiv/Rolodex', dry_run: true });
	});
});

describe('check_links', () => {
	it('reports dead links, ambiguous basenames and bad anchors', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('A/Dup', '# Dup A\n');
		await mdwiki.writePage('B/Dup', '# Dup B\n');
		await mdwiki.writePage('Ziel', '# Ziel\n\n## Echter Abschnitt\n');
		await mdwiki.writePage('Quelle', 'Zeile 1\n[[Fehlt]]\n[[Dup]]\n[[Ziel#Gibt Es Nicht]]\n[[Ziel#Echter Abschnitt]]\n');
		const res = await mdwiki.checkLinks('Quelle');
		expect(res.dead).toEqual(
			expect.arrayContaining([
				{ path: 'Quelle', line: 2, target: 'Fehlt' },
				{ path: 'Quelle', line: 3, target: 'Dup' }
			])
		);
		expect(res.ambiguous).toEqual([{ path: 'Quelle', target: 'Dup', candidates: ['A/Dup', 'B/Dup'] }]);
		expect(res.anchors).toEqual([{ path: 'Quelle', target: 'Ziel', heading: 'Gibt Es Nicht' }]);
		expect(res.counts.dead).toBe(2);
		expect(res.counts.anchors).toBe(1);
	});

	it('marks pages without incoming links, including root pages', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Einsam/Seite', 'kein Link hierher\n');
		await mdwiki.writePage('Wurzel', 'auch niemand\n');
		await mdwiki.writePage('Verlinkt', 'nur Text\n');
		await mdwiki.writePage('Verlinker', '[[Verlinkt]]\n');
		const res = await mdwiki.checkLinks();
		expect(res.orphans).toEqual(
			expect.arrayContaining([
				{ path: 'Einsam/Seite', root: false },
				{ path: 'Wurzel', root: true }
			])
		);
		expect(res.orphans.map((o) => o.path)).not.toContain('Verlinkt');
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
		await mdwiki.writePage('Bereich/A', '[[Fehlt]]\n');
		await mdwiki.writePage('Anders/B', '[[Auch Fehlt]]\n');
		const res = await mdwiki.checkLinks('Bereich');
		expect(res.dead.map((d) => d.path)).toEqual(['Bereich/A']);
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

	it('dry_run validates conflicts but writes nothing', async () => {
		const { mdwiki } = await makeMdwiki();
		const res = await mdwiki.writePages([{ path: 'Batch/Trocken', content: 'nur ein Plan\n' }], true);
		expect(res).toMatchObject({ dry_run: true });
		expect(await exists(mdwiki, 'Batch/Trocken')).toBe(false);
	});

	it('rolls back already written files when the disk fails', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('Batch/A', 'vorher\n');
		const store = mdwiki.store as unknown as { write: (...args: unknown[]) => Promise<unknown> };
		const original = store.write.bind(mdwiki.store);
		let calls = 0;
		store.write = async (...args: unknown[]) => {
			if (++calls === 2) throw new Error('disk full');
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
			{ path: 'Batch/Gut', content: '[[index]]\n' },
			{ path: 'Batch/Tot', content: '[[Gibt Es Nicht]]\n' }
		]);
		expect(res.written[0].warnings).toEqual([]);
		expect(res.written[1].warnings).toMatchObject([{ rule: 'dead_link', line: 1, message: expect.stringContaining('Gibt Es Nicht') }]);
		expect(await read(mdwiki, 'Batch/Tot')).toBe('[[Gibt Es Nicht]]\n');
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
