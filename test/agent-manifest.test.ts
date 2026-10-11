import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMcpServer } from '../src/lib/server/mcp';
import { checkPage, parseManifest, SECRET_PATTERNS } from '../src/lib/server/agent-manifest';
import { makeMdwiki } from './helpers';

const TOKEN = 'test-token-0123456789-0123456789-abcdef';
let dir: string;
let mdwiki: Awaited<ReturnType<typeof makeMdwiki>>['mdwiki'];
let pagesRoute: typeof import('../src/routes/api/v1/pages/[...path]/+server');
let manifestRoute: typeof import('../src/routes/api/v1/manifest/+server');
let validateRoute: typeof import('../src/routes/api/v1/validate/+server');
let mcpRoute: typeof import('../src/routes/mcp/+server');

beforeAll(async () => {
	const made = await makeMdwiki();
	dir = made.dir;
	made.mdwiki.stop();
	process.env.SPACE_DIR = dir;
	process.env.CACHE_DIR = made.cache;
	process.env.KROKI_URL = '';
	process.env.MDWIKI_API_TOKEN = TOKEN;
	pagesRoute = await import('../src/routes/api/v1/pages/[...path]/+server');
	manifestRoute = await import('../src/routes/api/v1/manifest/+server');
	validateRoute = await import('../src/routes/api/v1/validate/+server');
	mcpRoute = await import('../src/routes/mcp/+server');
	const svc = await import('../src/lib/server/service');
	afterAll(async () => (await svc.getMdwiki()).stop());
	mdwiki = await svc.getMdwiki();
});

const MANIFEST_FILE = () => path.join(dir, 'MANIFEST.md');
const req = (method: string, url: string, body?: unknown) =>
	new Request(`http://localhost${url}`, {
		method,
		headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
const call = (handler: Function, request: Request, params: Record<string, string> = {}) => handler({ request, params, url: new URL(request.url) });

const VALID = `---
manifest: 1
summary: "Write German notes. Keep a Stand key in every page."
pages:
  required_frontmatter: [Stand]
  forbidden_prefixes: ["Sources:"]
folders:
  Konventionen: { owner: "Steward", description: "Rules" }
  Server: { template: "Vorlagen/Server" }
checks: [secrets]
---
Full prose for humans and agents.
`;

async function mcpClient() {
	const [a, b] = InMemoryTransport.createLinkedPair();
	await buildMcpServer(mdwiki).connect(b);
	const client = new Client({ name: 'test', version: '1' });
	await client.connect(a);
	return client;
}
const text = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
const reset = async () => {
	fs.rmSync(MANIFEST_FILE(), { force: true });
	await mdwiki.index.refresh();
};

describe('without a MANIFEST', () => {
	it('behaves as before', async () => {
		await reset();
		const client = await mcpClient();
		expect(client.getInstructions()).toBeUndefined();
		expect(text(await client.callTool({ name: 'get_manifest', arguments: {} }))).toEqual({ exists: false });
		const res = await call(manifestRoute.GET, req('GET', '/api/v1/manifest'));
		expect(await res.json()).toEqual({ exists: false });
		const w = await call(pagesRoute.PUT, req('PUT', '/x', { content: 'Sources: x' }), { path: 'Whatever/Page' });
		expect((await w.json()).warnings).toEqual([]);
	});
});

describe('with a valid MANIFEST', () => {
	beforeAll(async () => {
		await reset();
		const res = await call(pagesRoute.PUT, req('PUT', '/x', { content: VALID }), { path: 'MANIFEST' });
		expect(res.status).toBe(200);
	});

	it('puts the summary into the initialize instructions of a real MCP client against /mcp', async () => {
		const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
			fetch: (url, init) => call(mcpRoute.POST, new Request(url as string, init)) as Promise<Response>
		});
		const client = new Client({ name: 'test', version: '1' });
		await client.connect(transport);
		const ins = client.getInstructions() ?? '';
		expect(ins).toContain('Write German notes.');
		expect(ins).toContain('get_manifest');
		await client.close();
	});

	it('serves rules, prose and hash over MCP and REST', async () => {
		const client = await mcpClient();
		const viaMcp = text(await client.callTool({ name: 'get_manifest', arguments: {} }));
		const viaRest = await (await call(manifestRoute.GET, req('GET', '/api/v1/manifest'))).json();
		expect(viaMcp).toEqual(viaRest);
		expect(viaMcp.exists).toBe(true);
		expect(viaMcp.path).toBe('MANIFEST');
		expect(viaMcp.rules.pages.required_frontmatter).toEqual(['Stand']);
		expect(viaMcp.prose).toContain('Full prose');
		expect(viaMcp.hash).toBe((await mdwiki.readPage('MANIFEST')).hash);
	});

	it('rejects invalid manifest writes with 400 manifest_invalid and keeps the file', async () => {
		const before = fs.readFileSync(MANIFEST_FILE(), 'utf8');
		const cases: Record<string, string> = {
			'yaml error': '---\nmanifest: [1\n---\nx',
			'missing summary': '---\nmanifest: 1\n---\nx',
			'unknown key': '---\nmanifest: 1\nsummary: s\nchecs: [secrets]\n---\nx',
			'unknown nested key': '---\nmanifest: 1\nsummary: s\npages:\n  required_frontmater: [a]\n---\nx',
			'summary too long': `---\nmanifest: 1\nsummary: "${'a'.repeat(2001)}"\n---\nx`,
			'no frontmatter': 'just prose'
		};
		for (const [name, content] of Object.entries(cases)) {
			const res = await call(pagesRoute.PUT, req('PUT', '/x', { content }), { path: 'MANIFEST' });
			expect(res.status, name).toBe(400);
			const body = await res.json();
			expect(body.error, name).toBe('manifest_invalid');
			expect(body.issues.length, name).toBeGreaterThan(0);
			expect(fs.readFileSync(MANIFEST_FILE(), 'utf8'), name).toBe(before);
		}
	});

	it('keeps the last valid manifest when the file turns invalid outside the app', async () => {
		const good = fs.readFileSync(MANIFEST_FILE(), 'utf8');
		const hash = text(await (await mcpClient()).callTool({ name: 'get_manifest', arguments: {} })).hash;
		fs.writeFileSync(MANIFEST_FILE(), '---\nmanifest: 1\n---\nbroken', 'utf8');
		await mdwiki.index.refresh();
		const m = mdwiki.getManifest() as { exists: boolean; hash: string; invalid_on_disk?: unknown };
		expect(m.exists).toBe(true);
		expect(m.hash).toBe(hash);
		expect(m.invalid_on_disk).toBeTruthy();
		expect(mdwiki.manifestInstructions()).toContain('Write German notes.');
		// a valid change is picked up
		fs.writeFileSync(MANIFEST_FILE(), good.replace('Write German notes.', 'Write English notes.'), 'utf8');
		await mdwiki.index.refresh();
		expect(mdwiki.manifestInstructions()).toContain('Write English notes.');
		await call(pagesRoute.PUT, req('PUT', '/x', { content: good }), { path: 'MANIFEST' });
	});

	it('warns for missing frontmatter keys and still writes', async () => {
		const res = await call(pagesRoute.PUT, req('PUT', '/x', { content: '# T\nbody' }), { path: 'Konventionen/A' });
		expect(res.status).toBe(200);
		const { warnings } = await res.json();
		expect(warnings).toEqual([{ rule: 'missing_frontmatter', message: 'Frontmatter key "Stand" is missing' }]);
		expect((await mdwiki.readPage('Konventionen/A')).content).toContain('body');
	});

	it('warns for forbidden prefixes, except inside code fences', async () => {
		const content = '---\nStand: 1\n---\nok\n  Sources: x\n```\nSources: in fence\n```\nSources: y\n~~~\nSources: tilde\n~~~\n';
		const { warnings } = await (await call(pagesRoute.PUT, req('PUT', '/x', { content }), { path: 'Konventionen/B' })).json();
		expect(warnings.map((w: { rule: string; line: number }) => [w.rule, w.line])).toEqual([
			['forbidden_prefix', 5],
			['forbidden_prefix', 9]
		]);
	});

	it('warns for unknown top-level folders but not for root pages', async () => {
		const fm = '---\nStand: 1\n---\n';
		const bad = await (await call(pagesRoute.PUT, req('PUT', '/x', { content: fm }), { path: 'Nirgendwo/C' })).json();
		expect(bad.warnings.map((w: { rule: string }) => w.rule)).toEqual(['unknown_folder']);
		const ok = await (await call(pagesRoute.PUT, req('PUT', '/x', { content: fm }), { path: 'Server/C' })).json();
		expect(ok.warnings).toEqual([]);
		const root = await (await call(pagesRoute.PUT, req('PUT', '/x', { content: fm }), { path: 'RootPage' })).json();
		expect(root.warnings).toEqual([]);
	});

	it('flags possible secrets by rule and line, never by value', async () => {
		const secret = 'ghp_' + 'a1B2c3D4e5'.repeat(4);
		const content = `---\nStand: 1\n---\ntoken: ${secret}\n`;
		const res = await call(pagesRoute.PUT, req('PUT', '/x', { content }), { path: 'Server/Secret' });
		expect(res.status).toBe(200);
		const raw = JSON.stringify(await res.json());
		expect(raw).toContain('possible_secret');
		expect(raw).not.toContain(secret);
		expect(raw).not.toContain('a1B2c3D4e5');
		const viaValidate = JSON.stringify(await (await call(validateRoute.POST, req('POST', '/x', { path: 'Server/Secret', content }))).json());
		expect(viaValidate).not.toContain(secret);
		expect(JSON.parse(raw).warnings).toEqual([{ rule: 'possible_secret', message: expect.any(String), line: 4 }]);
	});

	it('append_to_page checks the resulting page', async () => {
		const client = await mcpClient();
		const r = text(await client.callTool({ name: 'append_to_page', arguments: { path: 'Server/Appended', content: 'Sources: z' } }));
		expect(r.warnings.map((w: { rule: string }) => w.rule).sort()).toEqual(['forbidden_prefix', 'missing_frontmatter']);
	});

	it('validate_page and POST /api/v1/validate return the same warnings without writing', async () => {
		const content = 'Sources: q\n';
		const client = await mcpClient();
		const viaMcp = text(await client.callTool({ name: 'validate_page', arguments: { path: 'Nirgendwo/D', content } }));
		const viaRest = await (await call(validateRoute.POST, req('POST', '/x', { path: 'Nirgendwo/D', content }))).json();
		expect(viaMcp).toEqual(viaRest);
		expect(viaMcp.warnings.map((w: { rule: string }) => w.rule).sort()).toEqual(['forbidden_prefix', 'missing_frontmatter', 'unknown_folder']);
		expect(mdwiki.index.get('Nirgendwo/D')).toBeUndefined();
		const write = text(await client.callTool({ name: 'write_page', arguments: { path: 'Nirgendwo/E', content } }));
		const dry = text(await client.callTool({ name: 'validate_page', arguments: { path: 'Nirgendwo/E', content } }));
		expect(write.warnings).toEqual(dry.warnings);
	});

	it('delete_page on MANIFEST switches the feature off', async () => {
		const res = await call(pagesRoute.DELETE, req('DELETE', '/x'), { path: 'MANIFEST' });
		expect(res.status).toBe(200);
		expect(mdwiki.manifestInstructions()).toBeNull();
		expect(mdwiki.getManifest()).toEqual({ exists: false });
	});
});

describe('invalid MANIFEST at startup', () => {
	it('activates nothing and get_manifest reports manifest_invalid', async () => {
		const made = await makeMdwiki();
		made.mdwiki.stop();
		fs.writeFileSync(path.join(made.dir, 'MANIFEST.md'), '---\nmanifest: 1\n---\nx');
		const { Mdwiki } = await import('../src/lib/server/service');
		const fresh = await new Mdwiki(made.mdwiki.config).start(false);
		expect(fresh.manifestInstructions()).toBeNull();
		expect(() => fresh.getManifest()).toThrowError(/invalid/);
		const before = fs.readFileSync(path.join(made.dir, 'MANIFEST.md'), 'utf8');
		await expect(fresh.appendToPage('MANIFEST', 'more')).rejects.toMatchObject({ code: 'manifest_invalid', status: 400 });
		await expect(fresh.uploadAttachment('MANIFEST.md', Buffer.from('no frontmatter'))).rejects.toMatchObject({ code: 'manifest_invalid' });
		expect(fs.readFileSync(path.join(made.dir, 'MANIFEST.md'), 'utf8')).toBe(before);
		try {
			fresh.getManifest();
		} catch (e) {
			expect((e as { code: string; details: { issues: unknown[] } }).code).toBe('manifest_invalid');
			expect((e as { details: { issues: unknown[] } }).details.issues.length).toBeGreaterThan(0);
		}
	});
});

describe('checkPage / secret patterns', () => {
	const rules = parseManifest('---\nmanifest: 1\nsummary: s\nchecks: [secrets]\n---\n');
	if (!rules.ok) throw new Error('fixture');
	const hits = (line: string) => checkPage(rules.value.rules, 'P', line).length;
	it.each([
		['private key', '-----BEGIN OPENSSH PRIVATE KEY-----'],
		['github token', 'ghp_' + 'x'.repeat(36)],
		['sk key', 'sk-' + 'y'.repeat(30)],
		['aws key', 'AKIA' + 'Q'.repeat(16)],
		['slack token', 'xoxb-1234567890-abcdefghij'],
		['bearer', 'Authorization: Bearer ' + 'z'.repeat(40)]
	])('detects %s', (_n, line) => expect(hits(line)).toBe(1));
	it.each(['Authorization: Bearer <token>', 'Bearer $MDWIKI_API_TOKEN', 'sk-short', 'plain text'])('ignores %s', (line) => expect(hits(line)).toBe(0));
	it('has a pattern list', () => expect(SECRET_PATTERNS.length).toBe(6));
});
