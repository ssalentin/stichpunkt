import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeCollections, getCollections } from '../src/lib/server/collection-service';
import { buildMcpServer } from '../src/lib/server/mcp';
import { makeMdwiki } from './helpers';

// Isolation: the process-wide store is pointed at a temp sqlite file before the first
// getCollections(), and the space is a temp copy of the fixture. Live data is never touched.
let spaceDir: string;
let dbDir: string;
let mdwiki: Awaited<ReturnType<typeof makeMdwiki>>['mdwiki'];
let booksId: string;

const BOOKS = {
	name: 'Books',
	icon: '📚',
	properties: [
		{ name: 'Title', type: 'title' },
		{ name: 'Author', type: 'text' },
		{ name: 'Pages', type: 'number' },
		{ name: 'Status', type: 'select', options: ['open', 'read'] },
		{ name: 'Tags', type: 'multi_select', options: ['nonfiction', 'novel'] }
	]
};

beforeAll(async () => {
	// point the process-wide store at the temp sqlite before anything can open it
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stichpunkt-collections-mcp-'));
	process.env.COLLECTIONS_DB = path.join(dbDir, 'collections.sqlite');
	const made = await makeMdwiki();
	spaceDir = made.dir;
	mdwiki = made.mdwiki;
	mdwiki.stop();
	process.env.SPACE_DIR = spaceDir;
	booksId = getCollections().create(BOOKS).id;
});

afterAll(() => {
	closeCollections();
	delete process.env.COLLECTIONS_DB;
	for (const dir of [spaceDir, dbDir]) fs.rmSync(dir, { recursive: true, force: true });
});

async function mcpClient(): Promise<Client> {
	const [a, b] = InMemoryTransport.createLinkedPair();
	await buildMcpServer(mdwiki).connect(b);
	const client = new Client({ name: 'test', version: '1' });
	await client.connect(a);
	return client;
}

const text = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text) as Record<string, unknown>;
const isErr = (r: unknown) => (r as { isError?: boolean }).isError === true;

async function addRow(client: Client, values: Record<string, unknown>, agent?: string) {
	const res = await client.callTool({ name: 'create_collection_row', arguments: { id: booksId, values, ...(agent ? { agent } : {}) } });
	expect(isErr(res)).toBe(false);
	return text(res) as { id: string; updated_at: string };
}

describe('collection MCP tools', () => {
	it('lists collections in the REST {databases} envelope', async () => {
		const client = await mcpClient();
		const listed = text(await client.callTool({ name: 'list_collections', arguments: {} }));
		const databases = listed.databases as Record<string, unknown>[];
		expect(databases).toHaveLength(1);
		expect(databases[0]).toMatchObject({ id: booksId, name: 'Books', row_count: 0, view_count: 0 });
		expect((databases[0].properties as { name: string }[]).map((p) => p.name)).toEqual(['Title', 'Author', 'Pages', 'Status', 'Tags']);
	});

	it('reads one collection with properties and views, like GET /api/v1/databases/[id]', async () => {
		const client = await mcpClient();
		const got = text(await client.callTool({ name: 'get_collection', arguments: { id: booksId } }));
		const store = getCollections();
		expect(got).toEqual({ ...store.get(booksId), views: store.views(booksId) });
		expect(got.properties).toBeDefined();
		expect(got.views).toEqual([]);

		const missing = await client.callTool({ name: 'get_collection', arguments: { id: 'no-such-uuid' } });
		expect(isErr(missing)).toBe(true);
		expect(text(missing)).toMatchObject({ error: 'not_found', status: 404 });
	});

	it('queries rows with a filter and a sort', async () => {
		const client = await mcpClient();
		await addRow(client, { Title: 'Dune', Author: 'Herbert', Pages: 412, Status: 'read' });
		await addRow(client, { Title: 'Neuromancer', Author: 'Gibson', Pages: 47, Status: 'open' });
		await addRow(client, { Title: 'Emma', Author: 'Austen', Pages: 474, Status: 'read' });

		const res = await client.callTool({
			name: 'query_collection_rows',
			arguments: { id: booksId, filters: [{ property: 'Status', op: 'eq', value: 'read' }], sorts: [{ property: 'Pages', direction: 'desc' }] }
		});
		expect(isErr(res)).toBe(false);
		const queried = text(res);
		expect(queried.total).toBe(2);
		expect((queried.rows as { values: Record<string, unknown> }[]).map((r) => r.values.Title)).toEqual(['Emma', 'Dune']);
		expect(queried.properties).toBeDefined();

		const bad = await client.callTool({ name: 'query_collection_rows', arguments: { id: booksId, filters: [{ property: 'Nope', op: 'eq', value: 1 }] } });
		expect(isErr(bad)).toBe(true);
		expect(text(bad)).toMatchObject({ error: 'bad_filter', status: 400 });
	});

	it('creates and updates a row round trip with base_updated_at', async () => {
		const client = await mcpClient();
		const created = await addRow(client, { Title: 'Foundation', Author: 'Asimov', Pages: 244, Status: 'open' });
		expect(created.updated_at).toMatch(/^\d{4}-/);

		const updated = await client.callTool({
			name: 'update_collection_row',
			arguments: { id: booksId, row_id: created.id, values: { Status: 'read', Pages: 256 }, base_updated_at: created.updated_at }
		});
		expect(isErr(updated)).toBe(false);
		expect(text(updated)).toMatchObject({ id: created.id, values: { Title: 'Foundation', Status: 'read', Pages: 256 } });
	});

	it('refuses a stale base_updated_at with the 409 conflict and carries current', async () => {
		const client = await mcpClient();
		const created = await addRow(client, { Title: 'Neuromancer II', Pages: 300 });
		const store = getCollections();
		const changed = store.updateRow(booksId, created.id, { Pages: 301 });

		const conflict = await client.callTool({
			name: 'update_collection_row',
			arguments: { id: booksId, row_id: created.id, values: { Pages: 999 }, base_updated_at: '1999-12-31T23:59:59.999Z' }
		});
		expect(isErr(conflict)).toBe(true);
		expect(text(conflict)).toMatchObject({ error: 'conflict', status: 409, current: changed.updated_at });

		// after the conflict the row still carries the winning write
		expect(store.getRow(booksId, created.id).values.Pages).toBe(301);
	});

	it('enforces the same value validation as REST (bad select option)', async () => {
		const client = await mcpClient();
		const viaMcp = await client.callTool({ name: 'create_collection_row', arguments: { id: booksId, values: { Title: 'Broken', Status: 'maybe' } } });
		expect(isErr(viaMcp)).toBe(true);
		expect(text(viaMcp)).toMatchObject({ error: 'bad_value', status: 400 });

		const rowsRoute = await import('../src/routes/api/v1/databases/[id]/rows/+server');
		const request = new Request(`http://localhost/api/v1/databases/${booksId}/rows`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ values: { Title: 'Broken', Status: 'maybe' } })
		});
		const viaRest = await rowsRoute.POST({ request, params: { id: booksId }, url: new URL(request.url) } as never);
		expect(viaRest.status).toBe(400);
		expect(await viaRest.json()).toMatchObject({ error: 'bad_value' });

		// nothing was written by either refusal
		const queried = text(await client.callTool({ name: 'query_collection_rows', arguments: { id: booksId } }));
		expect((queried.rows as { values: Record<string, unknown> }[]).some((r) => r.values.Title === 'Broken')).toBe(false);
	});

	it('deletes a row with the REST envelope', async () => {
		const client = await mcpClient();
		const created = await addRow(client, { Title: 'Doomed', Pages: 1 });
		const before = text(await client.callTool({ name: 'query_collection_rows', arguments: { id: booksId } })).total as number;

		const deleted = await client.callTool({ name: 'delete_collection_row', arguments: { id: booksId, row_id: created.id } });
		expect(isErr(deleted)).toBe(false);
		expect(text(deleted)).toEqual({ id: created.id, deleted: true });

		const after = text(await client.callTool({ name: 'query_collection_rows', arguments: { id: booksId } })).total as number;
		expect(after).toBe(before - 1);

		const again = await client.callTool({ name: 'delete_collection_row', arguments: { id: booksId, row_id: created.id } });
		expect(isErr(again)).toBe(true);
		expect(text(again)).toMatchObject({ error: 'not_found', status: 404 });
	});

	it('records every row write in the history with the actor', async () => {
		const client = await mcpClient();
		const created = await addRow(client, { Title: 'History', Pages: 10 });
		await client.callTool({
			name: 'update_collection_row',
			arguments: { id: booksId, row_id: created.id, values: { Pages: 20 }, agent: 'Claude' }
		});

		const entries = text(await client.callTool({ name: 'collection_history', arguments: { id: booksId, row_id: created.id } })) as unknown as Record<string, unknown>[];
		expect(entries.map((e) => e.op)).toEqual(['update', 'create']); // newest first
		expect(entries[0]).toMatchObject({ row_id: created.id, actor: 'Claude', before: { Title: 'History', Pages: 10 }, after: { Title: 'History', Pages: 20 } });
		expect(entries[1]).toMatchObject({ actor: 'mcp', before: null });
		expect(Number(entries[0].id) > Number(entries[1].id)).toBe(true);

		const whole = text(await client.callTool({ name: 'collection_history', arguments: { id: booksId } })) as unknown as Record<string, unknown>[];
		expect(whole.length).toBeGreaterThanOrEqual(2);
		expect(whole.every((e) => typeof e.at === 'string')).toBe(true);
	});
});
