import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handle } from '../src/hooks.server';
import { buildMcpServer } from '../src/lib/server/mcp';
import { makeMdwiki } from './helpers';

const TOKEN = 'test-token-0123456789-0123456789-abcdef';
let dir: string;
let mdwiki: Awaited<ReturnType<typeof makeMdwiki>>['mdwiki'];
let outside: string;

// route handlers talk to the process-wide singleton, so point it at a temp space first
let pagesRoute: typeof import('../src/routes/api/v1/pages/[...path]/+server');
let listRoute: typeof import('../src/routes/api/v1/pages/+server');
let attachRoute: typeof import('../src/routes/api/v1/attachments/[...path]/+server');
let queryRoute: typeof import('../src/routes/api/v1/query/+server');
let mcpRoute: typeof import('../src/routes/mcp/+server');
let fileRoute: typeof import('../src/routes/f/[...path]/+server');

beforeAll(async () => {
	const made = await makeMdwiki();
	dir = made.dir;
	mdwiki = made.mdwiki;
	outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mdwiki-outside-'));
	fs.writeFileSync(path.join(outside, 'secret.md'), 'top secret');
	process.env.SPACE_DIR = dir;
	process.env.CACHE_DIR = made.cache;
	process.env.KROKI_URL = '';
	process.env.MDWIKI_API_TOKEN = TOKEN;
	process.env.MAX_WRITE_BYTES = '2000';
	process.env.MAX_UPLOAD_BYTES = '5000';
	pagesRoute = await import('../src/routes/api/v1/pages/[...path]/+server');
	listRoute = await import('../src/routes/api/v1/pages/+server');
	attachRoute = await import('../src/routes/api/v1/attachments/[...path]/+server');
	queryRoute = await import('../src/routes/api/v1/query/+server');
	mcpRoute = await import('../src/routes/mcp/+server');
	fileRoute = await import('../src/routes/f/[...path]/+server');
	const svc = await import('../src/lib/server/service');
	// the singleton must stop polling when tests end
	afterAll(async () => (await svc.getMdwiki()).stop());
	const s = await svc.getMdwiki();
	mdwiki.stop();
	mdwiki = s;
});

const req = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
	new Request(`http://localhost${url}`, {
		method,
		headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers },
		body: body === undefined ? undefined : typeof body === 'string' ? body : body instanceof Uint8Array ? new Uint8Array(body) : JSON.stringify(body)
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

	it('requires the token for every path when the proxy marked the request as machine-zone', async () => {
		const zone = { 'x-mdwiki-zone': 'machine' };
		for (const url of ['/', '/Familie', '/_ui/page', '/_ui/titles', '/api/%2e%2e/_ui/page', '/tag/x', '/f/a.png']) {
			expect(await run('PUT', url, { ...zone, origin: 'http://localhost' }), url).toEqual({ status: 401, reached: false });
			expect(await run('GET', url, zone), url).toEqual({ status: 401, reached: false });
		}
		expect(await run('GET', '/Familie', { ...zone, authorization: `Bearer ${TOKEN}` })).toEqual({ status: 200, reached: true });
		// without the marker the UI stays open (Authelia router)
		expect(await run('GET', '/Familie')).toEqual({ status: 200, reached: true });
	});

	it('detects the encoded-dot-segment bypass at the URL level', () => {
		expect(new URL('http://localhost/api/%2e%2e/_ui/page').pathname).toBe('/_ui/page');
	});

	it('rejects a wrong token and a malformed header', async () => {
		expect((await run('GET', '/api/v1/pages', { authorization: 'Bearer nope' })).status).toBe(401);
		expect((await run('GET', '/api/v1/pages', { authorization: TOKEN })).status).toBe(401);
		expect((await run('GET', '/api/v1/pages', { authorization: `Basic ${TOKEN}` })).status).toBe(401);
	});

	it('lets the right token through, and fails closed when no token is configured', async () => {
		expect(await run('GET', '/mcp', { authorization: `Bearer ${TOKEN}` })).toEqual({ status: 200, reached: true });
		process.env.MDWIKI_API_TOKEN = '';
		expect((await run('GET', '/api/v1/pages', { authorization: 'Bearer ' })).status).toBe(401);
		expect((await run('GET', '/api/v1/pages', { authorization: 'Bearer x' })).status).toBe(401);
		process.env.MDWIKI_API_TOKEN = TOKEN;
	});

	it('leaves the web UI readable (Authelia sits in front) but exposes no write endpoint', async () => {
		expect(await run('GET', '/Server/Alpha')).toEqual({ status: 200, reached: true });
		for (const method of ['PUT', 'POST', 'DELETE', 'PATCH']) {
			for (const url of ['/_ui/page', '/_ui/toggle', '/_ui/upload']) {
				expect(await run(method, url, { origin: 'http://localhost' }), `${method} ${url}`).toEqual({ status: 405, reached: false });
			}
		}
	});
});

describe('weak tokens', () => {
	const status = async (configured: string, sent: string) => {
		const prev = process.env.MDWIKI_API_TOKEN;
		process.env.MDWIKI_API_TOKEN = configured;
		try {
			const request = new Request('http://localhost/api/v1/pages', { headers: { authorization: `Bearer ${sent}` } });
			const res = await handle({
				event: { url: new URL(request.url), request } as never,
				resolve: async () => new Response('ok')
			});
			return res.status;
		} finally {
			process.env.MDWIKI_API_TOKEN = prev;
		}
	};

	it('answers 401 for the placeholder and for 31 characters, even when the client sends exactly that', async () => {
		expect(await status('change-me', 'change-me')).toBe(401);
		expect(await status('a'.repeat(31), 'a'.repeat(31))).toBe(401);
		expect(await status('a'.repeat(32), 'a'.repeat(32))).toBe(200);
	});

	it('logs one error that never contains the token', async () => {
		const { vi } = await import('vitest');
		vi.resetModules(); // the warn-once flag is module state; earlier tests may already have set it
		const auth = await import('../src/lib/server/auth');
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			expect(auth.configuredToken('short-secret')).toBe('');
			expect(auth.configuredToken('short-secret')).toBe('');
			expect(spy).toHaveBeenCalledTimes(1);
			expect(JSON.stringify(spy.mock.calls)).not.toContain('short-secret');
		} finally {
			spy.mockRestore();
		}
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
		await mdwiki.index.refresh();
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
		expect(mdwiki.search('top secret').results).toEqual([]); // not indexed either
	});
});

describe('REST: POST /api/v1/query', () => {
	it('returns rows for the same schema the block uses', async () => {
		const res = await call(queryRoute.POST, req('POST', '/api/v1/query', { tag: 'infra', sort: 'title asc', show: 'list' }));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.total).toBe(1);
		expect(body.rows.map((r: { path: string }) => r.path)).toEqual(['Server/Alpha']);
	});

	it('resolves `this` from the optional self field', async () => {
		// a page that links to Server/Alpha, written for this test only
		await call(pagesRoute.PUT, req('PUT', '/api/v1/pages/Link/To', { content: '[[Server/Alpha]]\n', base_hash: '' }), { path: 'Link/To' });
		const res = await call(queryRoute.POST, req('POST', '/api/v1/query', { 'links-to': 'this', self: 'Server/Alpha', sort: 'title asc' }));
		const body = await res.json();
		expect(body.rows.map((r: { path: string }) => r.path)).toContain('Link/To');
		expect(body.rows.map((r: { path: string }) => r.path)).not.toContain('Server/Alpha');
	});

	it('rejects an invalid query with 400 and a message', async () => {
		const res = await call(queryRoute.POST, req('POST', '/api/v1/query', { limit: 'many' }));
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('bad_query');
		expect(typeof body.message).toBe('string');
	});

	it('requires the token like every /api route', async () => {
		const request = new Request('http://localhost/api/v1/query', { method: 'POST', body: '{}' });
		const res = await handle({
			event: { url: new URL(request.url), request } as never,
			resolve: async () => new Response('ok')
		});
		expect(res.status).toBe(401);
	});
});

describe('/f/ attachment route', () => {
	const get = (p: string) =>
		call(fileRoute.GET, new Request('http://localhost/f/x'), { path: p }).then(
			(r: Response) => r.status,
			(e: { status?: number }) => e.status
		);

	it('rejects traversal, escaping symlinks and disallowed extensions, and serves nothing outside the space', async () => {
		fs.writeFileSync(path.join(outside, 'leak.png'), 'leaked');
		fs.symlinkSync(outside, path.join(dir, 'fescape'));
		fs.symlinkSync(path.join(outside, 'leak.png'), path.join(dir, 'leak.png'));
		expect(await get('../leak.png')).toBe(400);
		expect(await get('Server/../../leak.png')).toBe(400);
		expect(await get('fescape/leak.png')).toBe(400);
		expect(await get('leak.png')).toBe(400);
		expect(await get('Server/run.sh')).toBe(400);
		expect(await get('Server/page.html')).toBe(400);
	});
});

describe('delete through an escaping symlink', () => {
	it('answers 400 via REST and MCP and keeps the outside file', async () => {
		const victim = path.join(outside, 'victim.md');
		fs.writeFileSync(victim, 'keep me');
		fs.symlinkSync(victim, path.join(dir, 'del-link.md'));
		fs.symlinkSync(outside, path.join(dir, 'del-dir'));
		for (const p of ['del-link', 'del-dir/victim']) {
			const res = await call(pagesRoute.DELETE, req('DELETE', '/x'), { path: p });
			expect(res.status, `REST ${p}`).toBe(400);
		}
		const [a, b] = InMemoryTransport.createLinkedPair();
		await buildMcpServer(mdwiki).connect(b);
		const client = new Client({ name: 'test', version: '1' });
		await client.connect(a);
		for (const p of ['del-link', 'del-dir/victim']) {
			const r = await client.callTool({ name: 'delete_page', arguments: { path: p } });
			expect(r.isError, `MCP ${p}`).toBe(true);
			expect(JSON.parse((r.content as { text: string }[])[0].text).status).toBe(400);
		}
		expect(fs.readFileSync(victim, 'utf8')).toBe('keep me');
	});
});

describe('MCP', () => {
	async function connect() {
		const [a, b] = InMemoryTransport.createLinkedPair();
		await buildMcpServer(mdwiki).connect(b);
		const client = new Client({ name: 'test', version: '1' });
		await client.connect(a);
		return client;
	}
	const text = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content[0]).text);

	it('lists every tool of the spec', async () => {
		const client = await connect();
		const names = (await client.listTools()).tools.map((t) => t.name).sort();
		expect(names).toEqual(
			['append_to_page', 'delete_page', 'get_backlinks', 'list_pages', 'list_tags', 'pages_by_tag', 'query_pages', 'read_page', 'search', 'upload_attachment', 'write_page'].sort()
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
		expect((await t('search', { query: 'mcp-tag' })).results.map((h: { path: string }) => h.path)).toContain('Mcp/Page');
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

	it('query_pages returns the same rows as the pages block', async () => {
		const c = await connect();
		const r = await c.callTool({
			name: 'query_pages',
			arguments: { tag: 'infra', sort: 'title asc', show: 'table', columns: ['title', 'tags'] }
		});
		const body = text(r);
		expect(body.show).toBe('table');
		expect(body.total).toBe(1);
		expect(body.rows.map((x: { path: string }) => x.path)).toEqual(['Server/Alpha']);
		expect(body.columns).toEqual(['title', 'tags']);
	});

	it('query_pages rejects an invalid query through the shared schema', async () => {
		const c = await connect();
		// `sort` is a free string to the tool schema, so it reaches the strict query schema
		const r = await c.callTool({ name: 'query_pages', arguments: { sort: 'date sideways' } });
		expect(r.isError).toBe(true);
		expect(text(r).error).toBe('bad_query');
		expect(text(r).status).toBe(400);
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
		expect(json.result.tools.length).toBe(11);
		expect((await call(mcpRoute.GET, req('GET', '/mcp'))).status).toBe(405);
	});
});
