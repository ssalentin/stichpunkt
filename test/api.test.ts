import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handle } from '../src/hooks.server';
import { buildMcpServer } from '../src/lib/server/mcp';
import { makeFolio } from './helpers';

const TOKEN = 'test-token';
let dir: string;
let folio: Awaited<ReturnType<typeof makeFolio>>['folio'];
let outside: string;

// route handlers talk to the process-wide singleton, so point it at a temp space first
let pagesRoute: typeof import('../src/routes/api/v1/pages/[...path]/+server');
let listRoute: typeof import('../src/routes/api/v1/pages/+server');
let attachRoute: typeof import('../src/routes/api/v1/attachments/[...path]/+server');
let mcpRoute: typeof import('../src/routes/mcp/+server');

beforeAll(async () => {
	const made = await makeFolio();
	dir = made.dir;
	folio = made.folio;
	outside = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-outside-'));
	fs.writeFileSync(path.join(outside, 'secret.md'), 'top secret');
	process.env.SPACE_DIR = dir;
	process.env.CACHE_DIR = made.cache;
	process.env.KROKI_URL = '';
	process.env.FOLIO_API_TOKEN = TOKEN;
	process.env.MAX_WRITE_BYTES = '2000';
	process.env.MAX_UPLOAD_BYTES = '5000';
	pagesRoute = await import('../src/routes/api/v1/pages/[...path]/+server');
	listRoute = await import('../src/routes/api/v1/pages/+server');
	attachRoute = await import('../src/routes/api/v1/attachments/[...path]/+server');
	mcpRoute = await import('../src/routes/mcp/+server');
	const svc = await import('../src/lib/server/service');
	// the singleton must stop polling when tests end
	afterAll(async () => (await svc.getFolio()).stop());
	const s = await svc.getFolio();
	folio.stop();
	folio = s;
});

const req = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
	new Request(`http://localhost${url}`, {
		method,
		headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers },
		body: body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body)
	});

const call = (handler: Function, request: Request, params: Record<string, string> = {}) =>
	handler({ request, params, url: new URL(request.url) });

describe('auth gate (hooks.server)', () => {
	const run = async (method: string, url: string, headers: Record<string, string> = {}) => {
		let reached = false;
		const request = new Request(`http://localhost${url}`, { method, headers });
		const res = await handle({
			event: { url: new URL(request.url), request } as never,
			resolve: async () => {
				reached = true;
				return new Response('ok');
			}
		});
		return { status: res.status, reached };
	};

	it.each([
		'/mcp',
		'/mcp/',
		'/api/v1/pages',
		'/api/v1/pages/index',
		'/api',
		'/api/anything',
		'/API/v1/pages',
		'/%61pi/v1/pages',
		'//api/v1/pages',
		'/%2561pi/v1/pages',
		'/mcp%2F',
		'/api%'
	])('returns 401 without a token for %s', async (url) => {
		const r = await run('POST', url);
		expect(r).toEqual({ status: 401, reached: false });
	});

	it('rejects a wrong token and a malformed header', async () => {
		expect((await run('GET', '/api/v1/pages', { authorization: 'Bearer nope' })).status).toBe(401);
		expect((await run('GET', '/api/v1/pages', { authorization: TOKEN })).status).toBe(401);
		expect((await run('GET', '/api/v1/pages', { authorization: `Basic ${TOKEN}` })).status).toBe(401);
	});

	it('lets the right token through, and fails closed when no token is configured', async () => {
		expect(await run('GET', '/mcp', { authorization: `Bearer ${TOKEN}` })).toEqual({ status: 200, reached: true });
		process.env.FOLIO_API_TOKEN = '';
		expect((await run('GET', '/api/v1/pages', { authorization: 'Bearer ' })).status).toBe(401);
		expect((await run('GET', '/api/v1/pages', { authorization: 'Bearer x' })).status).toBe(401);
		process.env.FOLIO_API_TOKEN = TOKEN;
	});

	it('leaves the web UI open (Authelia sits in front) and checks origin on UI writes', async () => {
		expect(await run('GET', '/Server/Alpha')).toEqual({ status: 200, reached: true });
		expect((await run('PUT', '/_ui/page')).status).toBe(403);
		expect((await run('PUT', '/_ui/page', { origin: 'https://evil.example' })).status).toBe(403);
		expect((await run('PUT', '/_ui/page', { origin: 'http://localhost' })).reached).toBe(true);
	});
});

describe('REST: save conflicts', () => {
	it('answers 409 with the current version for a stale base_hash', async () => {
		const read = await (await call(pagesRoute.GET, req('GET', '/api/v1/pages/Server/Beta'), { path: 'Server/Beta' })).json();
		const first = await call(
			pagesRoute.PUT,
			req('PUT', '/api/v1/pages/Server/Beta', { content: 'agent was here\n', base_hash: read.hash }),
			{ path: 'Server/Beta' }
		);
		expect(first.status).toBe(200);
		const stale = await call(
			pagesRoute.PUT,
			req('PUT', '/api/v1/pages/Server/Beta', { content: 'my edit\n', base_hash: read.hash }),
			{ path: 'Server/Beta' }
		);
		expect(stale.status).toBe(409);
		const body = await stale.json();
		expect(body.error).toBe('conflict');
		expect(body.current.content).toBe('agent was here\n');
		expect(fs.readFileSync(path.join(dir, 'Server/Beta.md'), 'utf8')).toBe('agent was here\n');
	});

	it('treats base_hash "" as create-only', async () => {
		const ok = await call(pagesRoute.PUT, req('PUT', '/x', { content: 'a', base_hash: '' }), { path: 'Fresh/Page' });
		expect(ok.status).toBe(200);
		const again = await call(pagesRoute.PUT, req('PUT', '/x', { content: 'b', base_hash: '' }), { path: 'Fresh/Page' });
		expect(again.status).toBe(409);
	});

	it('appends, lists and deletes', async () => {
		await call(pagesRoute.POST, req('POST', '/x', { content: 'appended line' }), { path: 'Fresh/Page' });
		const read = await (await call(pagesRoute.GET, req('GET', '/x'), { path: 'Fresh/Page' })).json();
		expect(read.content).toBe('a\nappended line\n');
		const list = await (await call(listRoute.GET, req('GET', '/api/v1/pages?prefix=Fresh'))).json();
		expect(list.pages.map((p: { path: string }) => p.path)).toEqual(['Fresh/Page']);
		expect((await call(pagesRoute.DELETE, req('DELETE', '/x'), { path: 'Fresh/Page' })).status).toBe(200);
		expect((await call(pagesRoute.GET, req('GET', '/x'), { path: 'Fresh/Page' })).status).toBe(404);
	});
});

describe('path safety', () => {
	const bad = [
		'../secret',
		'Server/../../secret',
		'/etc/passwd',
		'C:/Windows/x',
		'Server//Alpha',
		'./Alpha',
		'Server\\Alpha',
		'.hidden/x',
		'Server/.silverbullet',
		'Alpha\u0000',
		'a'.repeat(600)
	];

	it.each(bad)('rejects page path %j on write, read and delete', async (p) => {
		for (const [handler, method, body] of [
			[pagesRoute.PUT, 'PUT', { content: 'x' }],
			[pagesRoute.GET, 'GET', undefined],
			[pagesRoute.DELETE, 'DELETE', undefined]
		] as const) {
			const res = await call(handler, req(method, '/x', body), { path: p });
			expect(res.status, `${method} ${p}`).toBe(400);
		}
		expect(fs.existsSync(path.join(path.dirname(dir), 'secret.md'))).toBe(false);
	});

	it('rejects disallowed extensions for attachments', async () => {
		for (const name of ['Server/run.sh', 'x.exe', 'Server/page.html', 'noext', 'x.md.php', 'x.js']) {
			const res = await call(attachRoute.PUT, req('PUT', '/x', new Uint8Array([1, 2, 3]), { 'content-type': 'application/octet-stream' }), { path: name });
			expect(res.status, name).toBe(400);
		}
		const ok = await call(attachRoute.PUT, req('PUT', '/x', new Uint8Array([137, 80, 78, 71]), { 'content-type': 'image/png' }), {
			path: 'Server/_attachments/x.png'
		});
		expect(ok.status).toBe(200);
		expect(fs.existsSync(path.join(dir, 'Server/_attachments/x.png'))).toBe(true);
	});

	it('rejects oversized page writes and uploads', async () => {
		const big = await call(pagesRoute.PUT, req('PUT', '/x', { content: 'a'.repeat(2500) }), { path: 'Big' });
		expect(big.status).toBe(413);
		const up = await call(attachRoute.PUT, req('PUT', '/x', new Uint8Array(6000)), { path: 'Big/_attachments/b.png' });
		expect(up.status).toBe(413);
		expect(fs.existsSync(path.join(dir, 'Big'))).toBe(false);
	});

	it('refuses to read or write through symlinks that leave the space', async () => {
		fs.symlinkSync(outside, path.join(dir, 'escape'));
		fs.symlinkSync(path.join(outside, 'secret.md'), path.join(dir, 'linked.md'));
		fs.symlinkSync(path.join(outside, 'not-yet.md'), path.join(dir, 'dangling.md'));
		await folio.index.refresh();
		for (const p of ['escape/secret', 'escape/new', 'linked', 'dangling']) {
			const w = await call(pagesRoute.PUT, req('PUT', '/x', { content: 'pwned' }), { path: p });
			expect(w.status, `write ${p}`).toBe(400);
			const r = await call(pagesRoute.GET, req('GET', '/x'), { path: p });
			expect(r.status, `read ${p}`).toBe(p === 'dangling' ? 400 : 400);
		}
		const up = await call(attachRoute.PUT, req('PUT', '/x', new Uint8Array([1])), { path: 'escape/a.png' });
		expect(up.status).toBe(400);
		expect(fs.readFileSync(path.join(outside, 'secret.md'), 'utf8')).toBe('top secret');
		expect(fs.existsSync(path.join(outside, 'new.md'))).toBe(false);
		expect(fs.existsSync(path.join(outside, 'not-yet.md'))).toBe(false);
		expect(folio.search('top secret')).toEqual([]); // not indexed either
	});
});

describe('MCP', () => {
	async function connect() {
		const [a, b] = InMemoryTransport.createLinkedPair();
		await buildMcpServer(folio).connect(b);
		const client = new Client({ name: 'test', version: '1' });
		await client.connect(a);
		return client;
	}
	const text = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content[0]).text);

	it('lists every tool of the spec', async () => {
		const client = await connect();
		const names = (await client.listTools()).tools.map((t) => t.name).sort();
		expect(names).toEqual(
			['append_to_page', 'delete_page', 'get_backlinks', 'list_pages', 'list_tags', 'pages_by_tag', 'read_page', 'search', 'upload_attachment', 'write_page'].sort()
		);
	});

	it('runs every tool end to end', async () => {
		const c = await connect();
		const t = async (name: string, args: Record<string, unknown>) => {
			const r = await c.callTool({ name, arguments: args });
			return text(r);
		};
		const w = await t('write_page', { path: 'Mcp/Page', content: 'hello #mcp-tag [[Server/Alpha]]\n', base_hash: '' });
		expect(w.created).toBe(true);
		const r = await t('read_page', { path: 'Mcp/Page' });
		expect(r.hash).toBe(w.hash);
		expect((await t('append_to_page', { path: 'Mcp/Page', content: 'more' })).hash).not.toBe(w.hash);
		expect((await t('search', { query: 'mcp-tag' })).map((h: { path: string }) => h.path)).toContain('Mcp/Page');
		expect((await t('list_pages', { prefix: 'Mcp' })).map((p: { path: string }) => p.path)).toEqual(['Mcp/Page']);
		expect((await t('list_tags', {})).find((x: { name: string }) => x.name === 'mcp-tag').count).toBe(1);
		expect((await t('pages_by_tag', { tag: 'mcp-tag' })).map((p: { path: string }) => p.path)).toEqual(['Mcp/Page']);
		expect((await t('get_backlinks', { path: 'Server/Alpha' })).map((b: { path: string }) => b.path)).toContain('Mcp/Page');
		const up = await t('upload_attachment', { path: 'Mcp/_attachments/a.pdf', content_base64: Buffer.from('%PDF-1.4').toString('base64') });
		expect(up.size).toBe(8);
		expect(fs.readFileSync(path.join(dir, 'Mcp/_attachments/a.pdf'), 'utf8')).toBe('%PDF-1.4');
		expect((await t('delete_page', { path: 'Mcp/Page' })).deleted).toBe(true);
		expect((await c.callTool({ name: 'read_page', arguments: { path: 'Mcp/Page' } })).isError).toBe(true);
	});

	it('write_page with a stale base_hash is an error carrying the current version', async () => {
		const c = await connect();
		const call = async (name: string, args: Record<string, unknown>) => {
			const r = await c.callTool({ name, arguments: args });
			return { isError: r.isError, body: text(r) };
		};
		const first = await call('write_page', { path: 'Mcp/Conflict', content: 'v1' });
		await call('write_page', { path: 'Mcp/Conflict', content: 'v2 by someone else' });
		const stale = await call('write_page', { path: 'Mcp/Conflict', content: 'v3', base_hash: first.body.hash });
		expect(stale.isError).toBe(true);
		expect(stale.body).toMatchObject({ error: 'conflict', status: 409, current: { content: 'v2 by someone else' } });
		expect(fs.readFileSync(path.join(dir, 'Mcp/Conflict.md'), 'utf8')).toBe('v2 by someone else');
	});

	it('rejects traversal and disallowed uploads through tools', async () => {
		const c = await connect();
		for (const [name, args] of [
			['write_page', { path: '../evil', content: 'x' }],
			['read_page', { path: '/etc/passwd' }],
			['upload_attachment', { path: 'x/run.sh', content_base64: 'AAAA' }],
			['upload_attachment', { path: '../x.png', content_base64: 'AAAA' }]
		] as const) {
			const r = await c.callTool({ name, arguments: args });
			expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
			expect(text(r).status).toBe(400);
		}
	});

	it('serves Streamable HTTP over the /mcp route (stateless, JSON)', async () => {
		const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
		const res = await call(
			mcpRoute.POST,
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: {
					authorization: `Bearer ${TOKEN}`,
					'content-type': 'application/json',
					accept: 'application/json, text/event-stream'
				},
				body: JSON.stringify(body)
			})
		);
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.result.tools.length).toBe(10);
		expect((await call(mcpRoute.GET, req('GET', '/mcp'))).status).toBe(405);
	});
});
