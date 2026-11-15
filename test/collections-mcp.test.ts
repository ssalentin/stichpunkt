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

// Grouping and aggregates over both paths. A dedicated collection keeps the numbers deterministic.
describe('grouping and aggregates over REST and MCP', () => {
	let filmsId: string;

	beforeAll(() => {
		const store = getCollections();
		filmsId = store
			.create({
				name: 'Films',
				properties: [
					{ name: 'Title', type: 'title' },
					{ name: 'Rating', type: 'number' },
					{ name: 'Genre', type: 'select', options: ['sci-fi', 'drama'] }
				]
			})
			.id;
		store.createRow(filmsId, { Title: 'Arrival', Rating: 8, Genre: 'sci-fi' });
		store.createRow(filmsId, { Title: 'Blade Runner', Rating: 8, Genre: 'sci-fi' });
		store.createRow(filmsId, { Title: 'Amour', Rating: 9, Genre: 'drama' });
		store.createRow(filmsId, { Title: 'Unrated' });
	});

	const rest = (route: string, init: RequestInit = {}) =>
		new Request(`http://localhost/api/v1/databases/${filmsId}/${route}`, {
			...init,
			headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }
		});

	it('REST: views POST persists group_by and aggregates and the saved view applies on query', async () => {
		const viewsRoute = await import('../src/routes/api/v1/databases/[id]/views/+server');
		const created = await viewsRoute.POST({
			request: rest('views', { method: 'POST', body: JSON.stringify({ name: 'By genre', group_by: { property: 'Genre' }, aggregates: { Rating: 'sum' } }) }),
			params: { id: filmsId },
			url: new URL(`http://localhost/api/v1/databases/${filmsId}/views`)
		} as never);
		expect(created.status).toBe(201);
		const view = await created.json();
		expect(view).toMatchObject({ name: 'By genre', group_by: { property: 'Genre', direction: 'asc' }, aggregates: { Rating: 'sum' } });

		const queryRoute = await import('../src/routes/api/v1/databases/[id]/query/+server');
		const res = await queryRoute.POST({
			request: rest('query', { method: 'POST', body: JSON.stringify({ view: view.id }) }),
			params: { id: filmsId },
			url: new URL(`http://localhost/api/v1/databases/${filmsId}/query`)
		} as never);
		expect(res.status).toBe(200);
		const queried = await res.json();
		expect(queried.groups).toEqual([
			{ key: 'drama', count: 1 },
			{ key: 'sci-fi', count: 2 },
			{ key: null, count: 1 }
		]);
		expect(queried.aggregates).toEqual({ Rating: { fn: 'sum', value: 25 } });
	});

	it('REST: query POST carries groups and aggregates and rejects bad ones with 400', async () => {
		const queryRoute = await import('../src/routes/api/v1/databases/[id]/query/+server');
		const res = await queryRoute.POST({
			request: rest('query', { method: 'POST', body: JSON.stringify({ group_by: { property: 'Rating', direction: 'desc' }, aggregates: { Title: 'count' } }) }),
			params: { id: filmsId },
			url: new URL(`http://localhost/api/v1/databases/${filmsId}/query`)
		} as never);
		const body = await res.json();
		expect(body.groups).toEqual([
			{ key: '9', count: 1 },
			{ key: '8', count: 2 },
			{ key: null, count: 1 }
		]);
		expect(body.aggregates).toEqual({ Title: { fn: 'count', value: 4 } });

		const badFn = await queryRoute.POST({
			request: rest('query', { method: 'POST', body: JSON.stringify({ aggregates: { Genre: 'sum' } }) }),
			params: { id: filmsId },
			url: new URL(`http://localhost/api/v1/databases/${filmsId}/query`)
		} as never);
		expect(badFn.status).toBe(400);
		expect(await badFn.json()).toMatchObject({ error: 'bad_aggregate' });

		const badGroup = await queryRoute.POST({
			request: rest('query', { method: 'POST', body: JSON.stringify({ group_by: { property: 'Nope' } }) }),
			params: { id: filmsId },
			url: new URL(`http://localhost/api/v1/databases/${filmsId}/query`)
		} as never);
		expect(badGroup.status).toBe(400);
		expect(await badGroup.json()).toMatchObject({ error: 'bad_group' });
	});

	it('REST: rows GET groups with ?group= and stays ungrouped without it', async () => {
		const rowsRoute = await import('../src/routes/api/v1/databases/[id]/rows/+server');
		const grouped = await rowsRoute.GET({ params: { id: filmsId }, url: new URL(`http://localhost/api/v1/databases/${filmsId}/rows?group=Genre`) } as never);
		const body = await grouped.json();
		expect(body.groups).toHaveLength(3);
		expect(body.aggregates).toBeNull();

		const plain = await rowsRoute.GET({ params: { id: filmsId }, url: new URL(`http://localhost/api/v1/databases/${filmsId}/rows`) } as never);
		expect((await plain.json()).groups).toBeNull();
	});

	it('MCP: query_collection_rows returns groups and aggregates', async () => {
		const client = await mcpClient();
		const res = await client.callTool({
			name: 'query_collection_rows',
			arguments: { id: filmsId, group_by: { property: 'Genre' }, aggregates: { Rating: 'average' } }
		});
		expect(isErr(res)).toBe(false);
		const queried = text(res);
		expect(queried.groups).toEqual([
			{ key: 'drama', count: 1 },
			{ key: 'sci-fi', count: 2 },
			{ key: null, count: 1 }
		]);
		expect(queried.aggregates).toEqual({ Rating: { fn: 'average', value: 25 / 3 } });
	});

	it('MCP: save_collection_view creates a working view and validates like REST', async () => {
		const client = await mcpClient();
		const saved = await client.callTool({
			name: 'save_collection_view',
			arguments: { id: filmsId, name: 'MCP view', group_by: { property: 'Genre', direction: 'desc' }, aggregates: { Rating: 'max' }, agent: 'Claude' }
		});
		expect(isErr(saved)).toBe(false);
		const view = text(saved);
		expect(view).toMatchObject({ name: 'MCP view', group_by: { property: 'Genre', direction: 'desc' }, aggregates: { Rating: 'max' } });

		const viaView = text(await client.callTool({ name: 'query_collection_rows', arguments: { id: filmsId, view: view.id } }));
		expect((viaView.groups as { key: string | null }[]).map((g) => String(g.key))).toEqual(['sci-fi', 'drama', 'null']);
		expect(viaView.aggregates).toEqual({ Rating: { fn: 'max', value: 9 } });

		const bad = await client.callTool({ name: 'save_collection_view', arguments: { id: filmsId, name: 'Broken', aggregates: { Genre: 'sum' } } });
		expect(isErr(bad)).toBe(true);
		expect(text(bad)).toMatchObject({ error: 'bad_aggregate', status: 400 });
	});

	it('MCP: get_collection shows the grouping fields on views', async () => {
		const client = await mcpClient();
		const got = text(await client.callTool({ name: 'get_collection', arguments: { id: filmsId } }));
		const views = got.views as Record<string, unknown>[];
		expect(views).toHaveLength(2);
		expect(views).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: 'By genre', group_by: { property: 'Genre', direction: 'asc' }, aggregates: { Rating: 'sum' } }),
				expect.objectContaining({ name: 'MCP view', group_by: { property: 'Genre', direction: 'desc' }, aggregates: { Rating: 'max' } })
			])
		);
	});
});
