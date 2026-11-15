import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { handle } from '../src/hooks.server';
import { closeCollections, getCollections } from '../src/lib/server/collection-service';
import { CollectionStore } from '../src/lib/server/collections';
import { buildInstanceExport, materializeInstanceExport } from '../src/lib/server/instance-export';
import { tempSpace } from './helpers';

const TOKEN = 'test-token-0123456789-0123456789-abcdef';
const AT = new Date('2026-11-15T10:00:00Z');
const pkgVersion = (JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

const BOOKS = {
	name: 'Bücher',
	icon: '📚',
	properties: [
		{ name: 'Titel', type: 'title' },
		{ name: 'Autor, Ada', type: 'text' },
		{ name: 'Größe', type: 'number' },
		{ name: 'Gelesen', type: 'checkbox' }
	]
};

const open: CollectionStore[] = [];
function setup(): CollectionStore {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stichpunkt-instance-export-'));
	const store = CollectionStore.open(path.join(dir, 'collections.sqlite'));
	open.push(store);
	return store;
}

afterEach(() => {
	for (const store of open.splice(0)) {
		try {
			store.close();
		} catch {
			/* already closed */
		}
	}
});

describe('instance export bundle', () => {
	it('carries a version header, every page and every collection as JSON and CSV', async () => {
		const dir = tempSpace();
		const store = setup();
		const books = store.create(BOOKS);
		store.createRow(books.id, { Titel: 'Die Welt, "neu"', 'Autor, Ada': 'x', Größe: 320, Gelesen: true });

		const bundle = await buildInstanceExport(store, dir, AT);
		expect(bundle.format).toBe('stichpunkt-export');
		expect(bundle.version).toBe(1);
		expect(bundle.exported_at).toBe('2026-11-15T10:00:00.000Z');
		expect(bundle.app_version).toBe(pkgVersion);

		const expectedPages = Object.fromEntries(
			['CONFIG.md', 'index.md', 'Library/Hidden.md', 'Notes/Garten.md', 'Query.md', 'Server.md', 'Server/Alpha.md', 'Server/Beta.md', 'Syntax.md'].map(
				(rel) => [rel, fs.readFileSync(path.join(dir, rel), 'utf8')]
			)
		);
		expect(bundle.pages).toEqual(expectedPages);

		expect(bundle.collections).toHaveLength(1);
		const entry = bundle.collections[0];
		expect(entry.format).toBe('stichpunkt-collection');
		expect(entry.collection.name).toBe('Bücher');
		expect(entry.rows).toHaveLength(1);
		// RFC 4180: the comma forces quoting, the umlaut is kept verbatim in UTF-8
		expect(entry.csv).toBe('Titel,"Autor, Ada",Größe,Gelesen\r\n"Die Welt, ""neu""",x,320,true\r\n');
	});
});

describe('GET /api/v1/export', () => {
	let route: typeof import('../src/routes/api/v1/export/+server');
	let dir: string;

	beforeAll(async () => {
		dir = tempSpace();
		const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stichpunkt-instance-db-'));
		process.env.SPACE_DIR = dir;
		process.env.COLLECTIONS_DB = path.join(dbDir, 'collections.sqlite');
		process.env.MDWIKI_API_TOKEN = TOKEN;
		route = await import('../src/routes/api/v1/export/+server');
	});

	afterAll(() => closeCollections());

	const call = (request: Request) => route.GET({ request, params: {}, url: new URL(request.url) } as never);

	it('requires the bearer token like the collection export route', async () => {
		const request = new Request('http://localhost/api/v1/export');
		const res = await handle({
			event: { url: new URL(request.url), request } as never,
			resolve: async () => new Response('ok')
		});
		expect(res.status).toBe(401);
	});

	it('serves the bundle as a dated JSON attachment', async () => {
		const store = getCollections();
		const books = store.create(BOOKS);
		store.createRow(books.id, { Titel: 'Die Welt', 'Autor, Ada': 'x', Größe: 12 });

		const request = new Request('http://localhost/api/v1/export', { headers: { authorization: `Bearer ${TOKEN}` } });
		const res = await call(request);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
		expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="stichpunkt-export-\d{4}-\d{2}-\d{2}\.json"$/);
		expect(res.headers.get('cache-control')).toBe('no-store');

		const body = await res.json();
		expect(body).toMatchObject({ format: 'stichpunkt-export', version: 1, app_version: pkgVersion });
		expect(body.exported_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		expect(body.pages['Server/Alpha.md']).toBe(fs.readFileSync(path.join(dir, 'Server/Alpha.md'), 'utf8'));
		expect(body.collections).toHaveLength(1);
		expect(body.collections[0].csv).toBe('Titel,"Autor, Ada",Größe,Gelesen\r\nDie Welt,x,12,\r\n');
	});
});

describe('materializeInstanceExport', () => {
	it('writes the header file, byte-identical pages, and JSON and CSV per collection', async () => {
		const space = tempSpace();
		const store = setup();
		const books = store.create(BOOKS);
		store.createRow(books.id, { Titel: 'Die Welt', 'Autor, Ada': 'x', Größe: 320, Gelesen: true });
		const bundle = await buildInstanceExport(store, space, AT);

		const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stichpunkt-materialize-')), 'export');
		materializeInstanceExport(bundle, dir);

		expect(JSON.parse(fs.readFileSync(path.join(dir, 'export.json'), 'utf8'))).toEqual({
			format: 'stichpunkt-export',
			version: 1,
			exported_at: '2026-11-15T10:00:00.000Z',
			app_version: pkgVersion,
			pages: 9,
			collections: 1
		});
		for (const rel of Object.keys(bundle.pages)) {
			expect(fs.readFileSync(path.join(dir, 'pages', rel)), rel).toEqual(fs.readFileSync(path.join(space, rel)));
		}
		const json = JSON.parse(fs.readFileSync(path.join(dir, 'collections', 'Bucher.json'), 'utf8'));
		expect(json.csv).toBeUndefined();
		expect(json.collection.id).toBe(books.id);
		expect(json.collection.name).toBe('Bücher');
		expect(fs.readFileSync(path.join(dir, 'collections', 'Bucher.csv'), 'utf8')).toBe(bundle.collections[0].csv);
	});
});
