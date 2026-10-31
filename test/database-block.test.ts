import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CollectionStore } from '../src/lib/server/collections';
import { parseDatabaseBlock, renderDatabaseBlock } from '../src/lib/server/database-block';
import { renderBody } from '../src/lib/server/markdown';

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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stichpunkt-dbblock-'));
	const store = CollectionStore.open(path.join(dir, 'collections.sqlite'));
	open.push(store);
	const books = store.create({
		name: 'Bücher',
		properties: [
			{ name: 'Titel', type: 'title' },
			{ name: 'Status', type: 'select', options: ['Gelesen', 'Ungelesen'] }
		]
	});
	store.createRow(books.id, { Titel: 'Der goldene Handschuh', Status: 'Gelesen' });
	store.createRow(books.id, { Titel: 'Marzahn, mon amour', Status: 'Ungelesen' });
	return { store, books };
}

describe('database block', () => {
	it('reads the collection name from a bare line or a key', () => {
		expect(parseDatabaseBlock('Bücher')).toBe('Bücher');
		expect(parseDatabaseBlock('collection: Bücher')).toBe('Bücher');
		expect(parseDatabaseBlock('collection: "Bücher"\n')).toBe('Bücher');
		expect(() => parseDatabaseBlock('   ')).toThrow(/collection name/i);
	});

	it('renders the rows of the named collection with a link to the database', () => {
		const { store, books } = setup();
		const html = renderDatabaseBlock(store, 'collection: Bücher');
		expect(html).toContain('Bücher');
		expect(html).toContain('Der goldene Handschuh');
		expect(html).toContain('Marzahn, mon amour');
		expect(html).toContain(`/databases/${books.id}`);
		expect(html).toContain('<th>Titel</th>');
	});

	it('matches the name case-insensitively and escapes the cells', () => {
		const { store } = setup();
		expect(renderDatabaseBlock(store, 'bücher')).toContain('Der goldene Handschuh');
		store.createRow(store.list()[0].id, { Titel: '<script>alert(1)</script>' });
		const html = renderDatabaseBlock(store, 'Bücher');
		expect(html).not.toContain('<script>alert(1)</script>');
		expect(html).toContain('&lt;script&gt;');
	});

	it('turns the fence into a placeholder the service fills', () => {
		const rendered = renderBody('Vorher\n\n```database\ncollection: Bücher\n```\n\nNachher', { dir: '' });
		expect(rendered.databaseBlocks).toEqual([{ source: 'collection: Bücher' }]);
		expect(rendered.html).toContain('<!--database:0-->');
	});

	it('shows an error instead of an empty spot when the collection is missing', () => {
		const { store } = setup();
		const html = renderDatabaseBlock(store, 'Gibt es nicht');
		expect(html).toContain('nicht gefunden');
		expect(html).toContain('Gibt es nicht');
	});
});
