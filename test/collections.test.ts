import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CollectionStore } from '../src/lib/server/collections';
import { parseMarkdownTables, previewTable } from '../src/lib/server/collections-import';

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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stichpunkt-db-'));
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
		{ name: 'Status', type: 'select', options: ['offen', 'gelesen'] },
		{ name: 'Gelesen am', type: 'date' },
		{ name: 'Empfohlen', type: 'checkbox' },
		{ name: 'Tags', type: 'multi_select', options: ['sachbuch', 'roman'] }
	]
};

describe('collection store', () => {
	it('creates collections with typed properties and reports counts', () => {
		const store = setup();
		const books = store.create(BOOKS);
		expect(books.name).toBe('Bücher');
		expect(books.properties.map((p) => p.type)).toEqual(['title', 'text', 'number', 'select', 'date', 'checkbox', 'multi_select']);
		expect(store.list()).toMatchObject([{ id: books.id, name: 'Bücher', row_count: 0, view_count: 0 }]);
		expect(() => store.create(BOOKS)).toThrowError(/UNIQUE|constraint/i);
		expect(() => store.create({ name: 'X', properties: [{ name: 'A', type: 'text' }] })).toThrowError(/title property/);
	});

	it('creates, updates and deletes rows with typed values', () => {
		const store = setup();
		const books = store.create(BOOKS);
		const row = store.createRow(books.id, {
			Titel: 'Die Welt',
			Autor: 'Ada',
			Seiten: 320,
			Status: 'offen',
			'Empfohlen': true,
			Tags: ['sachbuch']
		});
		expect(row.values).toMatchObject({ Titel: 'Die Welt', Seiten: 320, Empfohlen: true, Tags: ['sachbuch'] });

		const updated = store.updateRow(books.id, row.id, { Status: 'gelesen', Seiten: '400' });
		expect(updated.values).toMatchObject({ Status: 'gelesen', Seiten: 400, Titel: 'Die Welt' });
		expect(store.history(books.id).map((h) => h.op)).toEqual(['update', 'create']);

		expect(() => store.createRow(books.id, { Seiten: 'viele' })).toThrowError(/must be a number/);
		expect(() => store.createRow(books.id, { Status: 'unbekannt' })).toThrowError(/not a defined option/);
		expect(() => store.createRow(books.id, { Nope: 1 })).toThrowError(/Unknown property/);

		store.deleteRow(books.id, row.id, 'test');
		expect(store.query(books.id).total).toBe(0);
		expect(store.history(books.id).map((h) => h.op)).toEqual(['delete', 'update', 'create']);
	});

	it('filters and sorts in SQL, not in the browser', () => {
		const store = setup();
		const books = store.create(BOOKS);
		const add = (values: Record<string, unknown>) => store.createRow(books.id, values);
		add({ Titel: 'A', Seiten: 100, Status: 'gelesen', Tags: ['roman'] });
		add({ Titel: 'B', Seiten: 300, Status: 'offen', Tags: ['sachbuch'] });
		add({ Titel: 'C', Seiten: 200, Status: 'offen', Tags: ['roman', 'sachbuch'] });

		expect(store.query(books.id, { filters: [{ property: 'Status', op: 'eq', value: 'offen' }] }).total).toBe(2);
		expect(store.query(books.id, { filters: [{ property: 'Titel', op: 'contains', value: 'b' }] }).rows.map((r) => r.values.Titel)).toEqual(['B']);
		expect(store.query(books.id, { filters: [{ property: 'Seiten', op: 'gt', value: 150 }] }).rows.map((r) => r.values.Titel)).toEqual(['B', 'C']);
		expect(store.query(books.id, { filters: [{ property: 'Tags', op: 'any_of', value: ['sachbuch'] }] }).total).toBe(2);
		expect(store.query(books.id, { filters: [{ property: 'Gelesen am', op: 'is_empty' }] }).total).toBe(3);

		expect(store.query(books.id, { sorts: [{ property: 'Seiten', direction: 'asc' }] }).rows.map((r) => r.values.Seiten)).toEqual([100, 200, 300]);
		expect(store.query(books.id, { sorts: [{ property: 'Seiten', direction: 'desc' }] }).rows.map((r) => r.values.Seiten)).toEqual([300, 200, 100]);
		expect(store.query(books.id, { sorts: [{ property: 'Titel', direction: 'asc' }] }).rows.map((r) => r.values.Titel)).toEqual(['A', 'B', 'C']);
		expect(() => store.query(books.id, { filters: [{ property: 'Nope', op: 'eq', value: 1 }] })).toThrowError(/Unknown property/);
	});

	it('saves views and applies them when no explicit filter is given', () => {
		const store = setup();
		const books = store.create(BOOKS);
		store.createRow(books.id, { Titel: 'A', Status: 'gelesen' });
		store.createRow(books.id, { Titel: 'B', Status: 'offen' });
		const view = store.saveView(books.id, {
			name: 'Offen',
			filters: [{ property: 'Status', op: 'eq', value: 'offen' }],
			sorts: [{ property: 'Titel', direction: 'desc' }],
			columns: ['Titel', 'Status']
		});
		expect(store.views(books.id)).toMatchObject([{ id: view.id, name: 'Offen', columns: ['Titel', 'Status'] }]);
		expect(store.query(books.id, { view: view.id }).rows.map((r) => r.values.Titel)).toEqual(['B']);
		// an explicit filter wins over the saved view
		expect(store.query(books.id, { view: view.id, filters: [{ property: 'Status', op: 'eq', value: 'gelesen' }] }).rows.map((r) => r.values.Titel)).toEqual(['A']);
	});

	it('rejects a stale row update and notifies live listeners', () => {
		const store = setup();
		const books = store.create(BOOKS);
		const row = store.createRow(books.id, { Titel: 'A' });
		const seen: string[] = [];
		const off = store.subscribe((id) => seen.push(id));
		store.updateRow(books.id, row.id, { Titel: 'B' }, 'test', row.updated_at);
		off();
		expect(seen).toEqual([books.id]);
		expect(() => store.updateRow(books.id, row.id, { Titel: 'C' }, 'test', row.updated_at)).toThrowError(/changed since/);
	});
});

describe('markdown table import', () => {
	it('parses pipe tables and ignores code fences', () => {
		const body = [
			'# Bücher',
			'',
			'| Titel | Autor | Seiten |',
			'| --- | --- | ---: |',
			'| A | Ada | 100 |',
			'| B | Bob | 200 |',
			'',
			'```',
			'| not | a | table |',
			'| --- | --- | --- |',
			'```'
		].join('\n');
		const tables = parseMarkdownTables(body);
		expect(tables).toHaveLength(1);
		expect(tables[0].heading).toBe('Bücher');
		expect(tables[0].columns).toEqual(['Titel', 'Autor', 'Seiten']);
		expect(tables[0].rows).toHaveLength(2);
		const preview = previewTable('Bibliothek/Bücher', tables[0]);
		expect(preview.columns).toEqual([
			{ name: 'Titel', type: 'title' },
			{ name: 'Autor', type: 'text' },
			{ name: 'Seiten', type: 'number' }
		]);
	});
});
