import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CollectionStore } from '../src/lib/server/collections';
import {
	exportCollection,
	exportCollectionCsv,
	exportFilename,
	readAllRows,
	toCsv
} from '../src/lib/server/collections-export';

const open: CollectionStore[] = [];
afterEach(() => {
	for (const store of open.splice(0)) {
		try {
			store.close();
		} catch {
			/* already closed */
		}
	}
});

function setup() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stichpunkt-export-'));
	const store = CollectionStore.open(path.join(dir, 'collections.sqlite'));
	open.push(store);
	return store;
}

const BOOKS = {
	name: 'Bücher',
	icon: '📚',
	properties: [
		{ name: 'Titel', type: 'title' },
		{ name: 'Autor', type: 'text' },
		{ name: 'Seiten', type: 'number' },
		{ name: 'Gelesen', type: 'checkbox' },
		{ name: 'Tags', type: 'multi_select', options: ['sachbuch', 'roman'] }
	]
};

describe('collection export', () => {
	it('exports a typed JSON snapshot with row ids and property metadata', () => {
		const store = setup();
		const books = store.create(BOOKS);
		const row = store.createRow(books.id, {
			Titel: 'Die Welt, "neu"',
			Autor: 'Ada',
			Seiten: 320,
			Gelesen: true,
			Tags: ['sachbuch', 'roman']
		});

		const out = exportCollection(store, books.id, new Date('2026-11-02T10:00:00Z'));
		expect(out.format).toBe('stichpunkt-collection');
		expect(out.version).toBe(1);
		expect(out.exported_at).toBe('2026-11-02T10:00:00.000Z');
		expect(out.collection).toMatchObject({ name: 'Bücher', icon: '📚' });
		expect(out.collection.properties.map((p) => p.type)).toEqual(['title', 'text', 'number', 'checkbox', 'multi_select']);
		expect(out.collection.properties[4].options).toEqual(['sachbuch', 'roman']);
		expect(out.rows).toHaveLength(1);
		expect(out.rows[0].id).toBe(row.id);
		expect(out.rows[0].values).toMatchObject({
			Titel: 'Die Welt, "neu"',
			Seiten: 320,
			Gelesen: true,
			Tags: ['sachbuch', 'roman']
		});
	});

	it('writes CSV with a property header, quoting and multi-select joining', () => {
		const store = setup();
		const books = store.create(BOOKS);
		store.createRow(books.id, { Titel: 'Die Welt, "neu"', Autor: 'Ada', Seiten: 320, Tags: ['sachbuch', 'roman'] });
		store.createRow(books.id, { Titel: 'Zeile\nzwei', Seiten: 12 });

		const csv = exportCollectionCsv(store, books.id);
		const lines = csv.split('\r\n');
		expect(lines[0]).toBe('Titel,Autor,Seiten,Gelesen,Tags');
		expect(lines[1]).toBe('"Die Welt, ""neu""",Ada,320,,"sachbuch, roman"');
		expect(lines[2]).toBe('"Zeile\nzwei",,12,,');
		expect(csv.endsWith('\r\n')).toBe(true);
	});

	it('leaves plain cells unquoted and keeps leading spaces quoted', () => {
		const properties = [{ id: 'p', name: 'A', type: 'text' as const, options: null, position: 0 }];
		const rows = [
			{ id: 'r1', created_at: '', updated_at: '', values: { A: 'plain' } },
			{ id: 'r2', created_at: '', updated_at: '', values: { A: ' padded ' } },
			{ id: 'r3', created_at: '', updated_at: '', values: { A: null } }
		];
		expect(toCsv(properties, rows)).toBe('A\r\nplain\r\n" padded "\r\n\r\n');
	});

	it('pages past the 500-row query limit', () => {
		const store = setup();
		const books = store.create(BOOKS);
		for (let i = 0; i < 602; i += 1) store.createRow(books.id, { Titel: `Band ${i}` });
		const rows = readAllRows(store, books.id);
		expect(rows).toHaveLength(602);
		expect(new Set(rows.map((r) => r.id)).size).toBe(602);
	});

	it('builds a header-safe filename for umlauts', () => {
		expect(exportFilename('Bücher', 'csv')).toEqual({ ascii: 'Bucher.csv', encoded: 'B%C3%BCcher.csv' });
		expect(exportFilename('!!!', 'json').ascii).toBe('collection.json');
	});
});
