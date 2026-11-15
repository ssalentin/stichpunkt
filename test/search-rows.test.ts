/**
 * Search over collection rows (issue #84).
 *
 * Two layers are covered: the row documents on the bare index (shape, ranking rules,
 * the byte-identical page scores) and the live path through Mdwiki with a real SQLite
 * file. Everything writes only to temp dirs: the fixture spaces and the collections DB
 * are created under `os.tmpdir()` and removed after each test, and `COLLECTIONS_DB` is
 * restored around the suite, so nothing here can reach the live instance.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildIndex, indexRows, rowHref, runSearch, type SearchIndex, type SearchRowInput } from '../src/lib/server/search';
import { fuzzyScore } from '../src/lib/fuzzy';
import { CollectionStore } from '../src/lib/server/collections';
import { closeCollections, getCollections } from '../src/lib/server/collection-service';
import { loadConfig } from '../src/lib/server/config';
import { collectionRowsForIndex, Mdwiki } from '../src/lib/server/service';

const page = (pathName: string, text: string, extra: { title?: string; tags?: string[]; mtimeMs?: number } = {}) => ({
	path: pathName,
	title: extra.title ?? pathName.slice(pathName.lastIndexOf('/') + 1),
	tags: extra.tags ?? [],
	headings: [],
	sections: text
		.split(/^## /m)
		.map((chunk, i) => (i === 0 ? { heading: '', slug: '', text: chunk } : { heading: chunk.split('\n')[0], slug: chunk.split('\n')[0].toLowerCase(), text: chunk }))
		.filter((s) => s.text.trim()),
	text,
	mtimeMs: extra.mtimeMs ?? 1000,
	hidden: pathName.startsWith('Library/')
});

const PAGES = [
	page('Notizen/Zahne', 'Zahnarzt Weber hat einen Termin fur die Reinigung.', { tags: ['zuhause'] }),
	page('Finanzen/Miete', 'Die Fixkosten der Wohnung: Miete 850 Euro, Strom 85 Euro.'),
	page('Setup/Backups', 'Backups laufen taglich. Ein Restore-Test gehort dazu.')
];

const ROLODEX = 'col-rolodex';
const FIXKOSTEN = 'col-fixkosten';

const rolodexRows: SearchRowInput[] = [
	{
		collectionId: ROLODEX,
		collectionName: 'Rolodex',
		rowId: 'row-weber',
		title: 'Dr. med. Weber',
		fields: [
			{ property: 'Name', text: 'Dr. med. Weber' },
			{ property: 'Telefon', text: '+49 170 5550112' },
			{ property: 'Ort', text: 'Hamburg' }
		],
		updatedMs: 1000
	},
	{
		collectionId: ROLODEX,
		collectionName: 'Rolodex',
		rowId: 'row-krause',
		title: 'Bettina Krause',
		fields: [
			{ property: 'Name', text: 'Bettina Krause' },
			{ property: 'Notiz', text: 'Gartenfest, bringt Kuchen mit' }
		],
		updatedMs: 2000
	}
];

const fixkostenRows: SearchRowInput[] = [
	{
		collectionId: FIXKOSTEN,
		collectionName: 'Fixkosten',
		rowId: 'row-strom',
		title: 'Strom',
		fields: [
			{ property: 'Posten', text: 'Strom' },
			{ property: 'Betrag', text: '85 Euro' },
			{ property: 'Anbieter', text: 'Stadtwerke Nordheide' }
		],
		updatedMs: 3000
	}
];

const search = (index: SearchIndex, query: string, limit = 10) =>
	runSearch(index, query, { limit, fuzzy: (needle, p) => Math.max(fuzzyScore(needle, p.title), fuzzyScore(needle, p.path)) });

function rowsIndex(): SearchIndex {
	const index = buildIndex(PAGES);
	indexRows(index, ROLODEX, rolodexRows);
	indexRows(index, FIXKOSTEN, fixkostenRows);
	return index;
}

describe('row documents on the index', () => {
	it('returns the row with its collection alongside page hits in one ranked list', () => {
		const r = search(rowsIndex(), 'Weber');
		const identities = r.results.map((h) => (h.row ? `row:${h.row.rowId}` : h.path));
		expect(identities).toContain('row:row-weber');
		expect(identities).toContain('Notizen/Zahne');
		expect(r.rows).toBe(1);
		expect(r.total).toBe(2); // one page + one row document
		const hit = r.results.find((h) => h.row)!;
		expect(hit.path).toBe('');
		expect(hit.tags).toEqual([]);
		expect(hit.layer).toBe('reading');
		expect(hit.title).toBe('Dr. med. Weber');
		expect(hit.row).toEqual({
			collectionId: ROLODEX,
			collectionName: 'Rolodex',
			rowId: 'row-weber',
			property: 'Name',
			href: rowHref(ROLODEX, 'row-weber')
		});
	});

	it('finds a Fixkosten value that occurs nowhere in the pages', () => {
		const r = search(rowsIndex(), 'stadtwerke');
		expect(r.results).toHaveLength(1);
		expect(r.results[0].row?.collectionName).toBe('Fixkosten');
		expect(r.results[0].snippet).toContain('Stadtwerke');
	});

	it('uses the property name as snippet context', () => {
		const r = search(rowsIndex(), '5550112');
		expect(r.results[0].row?.property).toBe('Telefon');
		expect(r.results[0].snippet).toContain('Telefon:');
	});

	it('lets rows match quoted phrases inside a field line', () => {
		const r = search(rowsIndex(), '"bringt Kuchen"');
		expect(r.results.map((h) => h.row?.rowId)).toEqual(['row-krause']);
		expect(search(rowsIndex(), '"Kuchen bringt"').results).toEqual([]);
	});

	it('skips rows for #tag and in: queries, which are page-scoped', () => {
		const tagged = search(rowsIndex(), 'Weber #zuhause');
		expect(tagged.rows).toBe(0);
		expect(tagged.results.every((h) => !h.row)).toBe(true);
		expect(tagged.results.map((h) => h.path)).toContain('Notizen/Zahne');
		const filed = search(rowsIndex(), 'Strom in:Finanzen');
		expect(filed.rows).toBe(0);
		expect(filed.results.every((h) => !h.row)).toBe(true);
	});

	it('builds one href through rowHref', () => {
		expect(rowHref('abc', 'def')).toBe('/databases/abc?edit=def');
		expect(rowHref('a b', 'c/d')).toBe('/databases/a%20b?edit=c%2Fd');
	});

	it('is idempotent: re-feeding the same rows leaves the index unchanged', () => {
		const index = buildIndex(PAGES);
		indexRows(index, ROLODEX, rolodexRows);
		const first = JSON.stringify(search(index, 'Weber').results.filter((h) => h.row));
		indexRows(index, ROLODEX, rolodexRows);
		expect(JSON.stringify(search(index, 'Weber').results.filter((h) => h.row))).toBe(first);
	});

	it('removes a whole collection with null', () => {
		const index = rowsIndex();
		indexRows(index, ROLODEX, null);
		const r = search(index, 'Weber');
		expect(r.rows).toBe(0);
		expect(r.results.every((h) => !h.row)).toBe(true);
	});

	it('validates its input instead of indexing garbage', () => {
		const index = buildIndex(PAGES);
		expect(() => indexRows(index, '', rolodexRows)).toThrow(/collectionId/);
		expect(() => indexRows(index, ROLODEX, 'x' as unknown as SearchRowInput[])).toThrow(/array or null/);
		expect(() => indexRows(index, ROLODEX, [{ ...rolodexRows[0], rowId: '' }])).toThrow(/rowId/);
		expect(() => indexRows(index, ROLODEX, [{ ...rolodexRows[0], collectionId: 'other' }])).toThrow(/belongs to/);
		expect(() => indexRows(index, ROLODEX, [{ ...rolodexRows[0], fields: [{ property: 'x' } as unknown as { property: string; text: string }] }])).toThrow(/field/);
	});
});

describe('page ranking does not regress', () => {
	// exercises titles, bodies, compounds, coverage, phrases, filters and the fuzzy fallback
	const QUERIES = ['Weber', 'Strom', 'Miete Strom', 'Backups', 'Zahnarzttermin', 'Fixkosten', '"Reinigung"', 'Krause', 'stadtwerke', 'Termin Reinigung', '#zuhause arzt', 'Strom in:Finanzen', 'Gesundhei'];

	const fingerprint = (index: SearchIndex) =>
		QUERIES.map((q) => {
			const r = search(index, q, 30);
			return JSON.stringify({
				pages: r.results.filter((h) => !h.row).map((h) => [h.path, h.score]),
				per_page: r.per_page,
				facets: r.facets
			});
		});

	const stats = (index: SearchIndex) => JSON.stringify({ df: [...index.df.entries()], vocab: [...index.vocab.entries()], avgLen: index.avgLen });

	it('keeps page scores, order, per_page and facets byte-identical after rows are fed', () => {
		const index = buildIndex(PAGES);
		const before = fingerprint(index);
		const statsBefore = stats(index);
		indexRows(index, ROLODEX, rolodexRows);
		indexRows(index, FIXKOSTEN, fixkostenRows);
		expect(fingerprint(index)).toEqual(before);
		// corpus statistics are page-only and untouched by the row feed
		expect(stats(index)).toBe(statsBefore);
		// and rows still arrived: the merged list carries them
		expect(search(index, 'Weber').rows).toBe(1);
	});

	it('scores pages identically to an index without any row code', () => {
		// the untouched suite proves the pre-row behaviour; here we pin the same query set
		// against a freshly built index, so a future change to page scoring shows up.
		const plain = buildIndex(PAGES);
		const withRows = rowsIndex();
		for (const q of QUERIES) {
			const pages = search(plain, q, 30).results.filter((h) => !h.row).map((h) => [h.path, h.score]);
			expect(search(withRows, q, 30).results.filter((h) => !h.row).map((h) => [h.path, h.score])).toEqual(pages);
		}
	});
});

describe('row mapping and allRows on the store', () => {
	const open: CollectionStore[] = [];
	const dirs: string[] = [];

	function tempStore(): CollectionStore {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stichpunkt-is84-db-'));
		dirs.push(dir);
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
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	it('allRows reads every row, uncapped, while query keeps the 500 limit', () => {
		const store = tempStore();
		const col = store.create({ name: 'Liste', properties: [{ name: 'Titel', type: 'title' }, { name: 'Notiz', type: 'text' }] });
		for (let i = 1; i <= 502; i++) store.createRow(col.id, { Titel: `Eintrag ${String(i).padStart(4, '0')}`, Notiz: 'quelltext' }, 'test');
		expect(store.query(col.id).rows).toHaveLength(100); // the UI default stays untouched
		expect(store.query(col.id, { limit: 1000 }).rows).toHaveLength(500); // and its hard cap
		expect(store.allRows(col.id).rows).toHaveLength(502);
		// the last row is in the index, not behind the cap
		const index = buildIndex(PAGES);
		indexRows(index, col.id, collectionRowsForIndex(store, col.id));
		expect(search(index, 'Eintrag 0501').results.some((h) => h.row?.rowId === store.allRows(col.id).rows[501].id)).toBe(true);
	});

	it('maps cells with the database block rule', () => {
		const store = tempStore();
		const col = store.create({
			name: 'Fixkosten',
			properties: [
				{ name: 'Posten', type: 'title' },
				{ name: 'Betrag', type: 'number' },
				{ name: 'Fallt an', type: 'date' },
				{ name: 'Bezahlt', type: 'checkbox' },
				{ name: 'Kategorien', type: 'multi_select', options: ['haus', 'auto'] },
				{ name: 'Link', type: 'url' },
				{ name: 'Notiz', type: 'text' }
			]
		});
		store.createRow(
			col.id,
			{ Posten: 'Strom', Betrag: 85, 'Fallt an': '2026-01-05', Bezahlt: true, Kategorien: ['haus', 'auto'], Link: 'https://example.com/strom', Notiz: null },
			'test'
		);
		const inputs = collectionRowsForIndex(store, col.id);
		expect(inputs).toHaveLength(1);
		expect(inputs[0].collectionName).toBe('Fixkosten');
		expect(inputs[0].title).toBe('Strom');
		expect(inputs[0].updatedMs).toBeGreaterThan(0);
		// checkbox cells are skipped, multi_select joined, dates/urls/numbers as text, empties left out
		expect(inputs[0].fields).toEqual([
			{ property: 'Posten', text: 'Strom' },
			{ property: 'Betrag', text: '85' },
			{ property: 'Fallt an', text: '2026-01-05' },
			{ property: 'Kategorien', text: 'haus, auto' },
			{ property: 'Link', text: 'https://example.com/strom' }
		]);
	});

	it('reports the store 404 for a vanished collection', () => {
		const store = tempStore();
		try {
			collectionRowsForIndex(store, 'missing');
			expect.unreachable();
		} catch (e) {
			expect((e as { status?: number }).status).toBe(404);
		}
		expect(() => store.allRows('missing')).toThrow();
	});
});

describe('live row index (Mdwiki + temp collections DB)', () => {
	const services: Mdwiki[] = [];
	const dirs: string[] = [];
	let previousDbEnv: string | undefined;

	beforeEach(() => {
		// the suite owns COLLECTIONS_DB; save/restore keeps anything outside it untouched
		previousDbEnv = process.env.COLLECTIONS_DB;
	});

	function fixtureSpace(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stichpunkt-is84-space-'));
		dirs.push(dir);
		fs.mkdirSync(path.join(dir, 'Notizen'));
		fs.writeFileSync(path.join(dir, 'Notizen', 'Fenster.md'), '# Fenster\n\nZahnarzt Weber empfiehlt neue Fenster für das Bad.');
		return dir;
	}

	function tempDb(): string {
		const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stichpunkt-is84-db-'));
		dirs.push(dbDir);
		const file = path.join(dbDir, 'collections.sqlite');
		process.env.COLLECTIONS_DB = file;
		return file;
	}

	async function boot(dir: string): Promise<Mdwiki> {
		const mdwiki = await new Mdwiki(loadConfig({ SPACE_DIR: dir, MDWIKI_API_TOKEN: 'test', POLL_INTERVAL: '600000' } as NodeJS.ProcessEnv)).start(false);
		services.push(mdwiki);
		return mdwiki;
	}

	const RODEX_PROPS = [{ name: 'Name', type: 'title' }, { name: 'Telefon', type: 'text' }];

	afterEach(() => {
		for (const mdwiki of services.splice(0)) mdwiki.stop();
		closeCollections();
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
		if (previousDbEnv === undefined) delete process.env.COLLECTIONS_DB;
		else process.env.COLLECTIONS_DB = previousDbEnv;
		vi.useRealTimers();
	});

	it('indexes rows at boot when the collections DB file already exists', async () => {
		// a restart with an existing DB must be searchable without any later open
		const dir = fixtureSpace();
		tempDb();
		const store = getCollections();
		const col = store.create({ name: 'Rolodex', properties: RODEX_PROPS });
		const row = store.createRow(col.id, { Name: 'Krause, Bettina', Telefon: '+49 170 5550112' }, 'test');
		const weberRow = store.createRow(col.id, { Name: 'Dr. med. Weber', Telefon: '+49 40 221100' }, 'test');
		closeCollections(); // the previous process shuts down here
		const mdwiki = await boot(dir);
		const r = mdwiki.search('5550112');
		expect(r.rows).toBe(1);
		expect(r.results[0].row).toEqual({
			collectionId: col.id,
			collectionName: 'Rolodex',
			rowId: row.id,
			property: 'Telefon',
			href: rowHref(col.id, row.id)
		});
		// page hits share the same list for a word both carry
		const weber = mdwiki.search('Weber');
		expect(weber.results.some((h) => h.row?.rowId === weberRow.id)).toBe(true);
		expect(weber.results.some((h) => h.path === 'Notizen/Fenster')).toBe(true);
	});

	it('does not create a database at boot, attaches on the first open and follows updates without a restart', async () => {
		const dir = fixtureSpace();
		const file = tempDb();
		const mdwiki = await boot(dir);
		expect(fs.existsSync(file)).toBe(false); // watching never opens the store itself
		const store = getCollections(); // this is what the first UI open does
		const col = store.create({ name: 'Rolodex', properties: RODEX_PROPS });
		const row = store.createRow(col.id, { Name: 'Krause, Bettina', Telefon: '5550112' }, 'test');
		mdwiki.flushCollectionRows(); // the trailing timer may not have run yet
		expect(mdwiki.search('5550112').results.some((h) => h.row?.rowId === row.id)).toBe(true);
		// an update flows through the same subscribe path: no restart, no page reload
		store.updateRow(col.id, row.id, { Name: 'Krause-Bachmann, Bettina' }, 'test');
		mdwiki.flushCollectionRows();
		expect(mdwiki.search('Bachmann').results.some((h) => h.row?.rowId === row.id)).toBe(true);
		// a page reload rebuilds the index; the rows must survive it
		fs.writeFileSync(path.join(dir, 'Notizen', 'Neu.md'), '# Neu\n\nFrischer Notiztext.');
		await mdwiki.index.refresh();
		const r = mdwiki.search('Bachmann');
		expect(r.results.some((h) => h.row?.rowId === row.id)).toBe(true);
		// deleting the collection removes its row hits through the same path
		store.delete(col.id);
		mdwiki.flushCollectionRows();
		expect(mdwiki.search('Bachmann').rows).toBe(0);
	});

	it('coalesces a burst of writes and converges on the current state', async () => {
		const dir = fixtureSpace();
		tempDb();
		const mdwiki = await boot(dir);
		vi.useFakeTimers();
		const store = getCollections();
		const col = store.create({ name: 'Rolodex', properties: RODEX_PROPS });
		// count the writes through the single SpaceIndex path to see the burst collapse
		const target = mdwiki.index as unknown as { setCollectionRows: (id: string, rows: SearchRowInput[] | null) => void };
		const original = target.setCollectionRows.bind(mdwiki.index);
		let calls = 0;
		target.setCollectionRows = (id, rows) => {
			calls++;
			original(id, rows);
		};
		const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'];
		for (const name of names) store.createRow(col.id, { Name: name, Telefon: `+49 170 555 ${name.length}` }, 'test');
		expect(calls).toBe(0); // nothing indexed mid-burst: the trailing timer decides
		await vi.advanceTimersByTimeAsync(400);
		expect(calls).toBe(1);
		for (const name of names) {
			expect(mdwiki.search(name).results.some((h) => h.row && h.title === name)).toBe(true);
		}
		vi.useRealTimers();
	});
});
