import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CollectionStore } from '../src/lib/server/collections';

// Isolation: every store opens a fresh mkdtemp sqlite file. Live data is never touched.
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

function setup(): CollectionStore {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stichpunkt-groups-'));
	const store = CollectionStore.open(path.join(dir, 'collections.sqlite'));
	open.push(store);
	return store;
}

/** Four rows: Status a/a/b/missing, Pages 10/20/30/missing, two dates on one day, mixed checkbox and tags. */
function library(store: CollectionStore): string {
	const c = store.create({
		name: 'Library',
		properties: [
			{ name: 'Title', type: 'title' },
			{ name: 'Note', type: 'text' },
			{ name: 'Pages', type: 'number' },
			{ name: 'Status', type: 'select', options: ['a', 'b'] },
			{ name: 'When', type: 'date' },
			{ name: 'Done', type: 'checkbox' },
			{ name: 'Tags', type: 'multi_select', options: ['x', 'y'] }
		]
	});
	store.createRow(c.id, { Title: 'One', Note: 'beta', Pages: 10, Status: 'a', When: '2026-01-05T10:00:00Z', Done: true, Tags: ['x', 'y'] });
	store.createRow(c.id, { Title: 'Two', Note: 'alpha', Pages: 20, Status: 'a', When: '2026-01-05T09:00:00Z', Done: false, Tags: ['x'] });
	store.createRow(c.id, { Title: 'Three', Note: 'gamma', Pages: 30, Status: 'b', When: '2026-02-01', Done: true });
	store.createRow(c.id, { Title: 'Four' });
	return c.id;
}

const titles = (rows: { values: Record<string, unknown> }[]) => rows.map((r) => r.values.Title);
const groupIds = (store: CollectionStore, id: string, property: string, direction?: 'asc' | 'desc') =>
	store
		.query(id, { group_by: { property, ...(direction ? { direction } : {}) } })
		.groups!.map((g) => `${String(g.key)}:${g.count}`);

describe('grouping', () => {
	it('groups by the raw select value, empty bucket last', () => {
		const store = setup();
		const id = library(store);
		expect(groupIds(store, id, 'Status')).toEqual(['a:2', 'b:1', 'null:1']);
		const q = store.query(id, { group_by: { property: 'Status', direction: 'desc' } });
		// desc flips the keys but never the empty bucket: it stays last
		expect(q.groups!.map((g) => `${String(g.key)}:${g.count}`)).toEqual(['b:1', 'a:2', 'null:1']);
		expect(titles(q.rows)).toEqual(['Three', 'One', 'Two', 'Four']);
	});

	it('truncates dates to the day, maps checkbox to true/false and keeps multi_select combinations exact', () => {
		const store = setup();
		const id = library(store);
		const dates = store.query(id, { group_by: { property: 'When' } });
		expect(dates.groups).toEqual([
			{ key: '2026-01-05', count: 2 },
			{ key: '2026-02-01', count: 1 },
			{ key: null, count: 1 }
		]);
		expect(titles(dates.rows)).toEqual(['Two', 'One', 'Three', 'Four']); // day order, then row order within the day

		expect(groupIds(store, id, 'Done')).toEqual(['false:1', 'true:2', 'null:1']);

		// v1 limitation: each stored combination is its own group, no per-option fan-out
		const tags = store.query(id, { group_by: { property: 'Tags' } });
		expect(tags.groups).toEqual([
			{ key: '["x","y"]', count: 1 },
			{ key: '["x"]', count: 1 },
			{ key: null, count: 2 }
		]);
	});

	it('counts groups and aggregates over the whole filtered set, not the page', () => {
		const store = setup();
		const id = library(store);
		const q = store.query(id, { group_by: { property: 'Status' }, aggregates: { Pages: 'sum' }, limit: 1, offset: 0 });
		expect(q.total).toBe(4);
		expect(q.groups!.map((g) => `${String(g.key)}:${g.count}`)).toEqual(['a:2', 'b:1', 'null:1']);
		expect(q.aggregates).toEqual({ Pages: { fn: 'sum', value: 60 } });
		expect(q.rows).toHaveLength(1);
	});

	it('stacks the requested sorts inside each group', () => {
		const store = setup();
		const id = library(store);
		const q = store.query(id, { group_by: { property: 'Status' }, sorts: [{ property: 'Pages', direction: 'desc' }] });
		expect(titles(q.rows)).toEqual(['Two', 'One', 'Three', 'Four']);
	});

	it('groups over the filtered subset', () => {
		const store = setup();
		const id = library(store);
		// the gte filter drops rows without a Pages value, so the empty bucket cannot appear
		const q = store.query(id, { group_by: { property: 'Status' }, filters: [{ property: 'Pages', op: 'gte', value: 20 }] });
		expect(q.groups).toEqual([
			{ key: 'a', count: 1 },
			{ key: 'b', count: 1 }
		]);
	});

	it('returns null groups and aggregates when inactive', () => {
		const store = setup();
		const id = library(store);
		const q = store.query(id);
		expect(q.groups).toBeNull();
		expect(q.aggregates).toBeNull();
	});
});

describe('aggregates', () => {
	it('computes number maths with empty cells excluded', () => {
		const store = setup();
		const id = library(store);
		const q = store.query(id, {
			aggregates: { Pages: 'sum', Title: 'count', Done: 'count_values', When: 'min', Note: 'max' }
		});
		expect(q.aggregates).toEqual({
			Pages: { fn: 'sum', value: 60 },
			Title: { fn: 'count', value: 4 },
			Done: { fn: 'count_values', value: 3 },
			When: { fn: 'min', value: '2026-01-05T09:00:00Z' }, // compares the raw stored strings
			Note: { fn: 'max', value: 'gamma' }
		});
	});

	it('averages filled values and returns null when nothing is filled', () => {
		const store = setup();
		const id = library(store);
		expect(store.query(id, { aggregates: { Pages: 'average' } }).aggregates).toEqual({ Pages: { fn: 'average', value: 20 } });
		const empty = store.query(id, { aggregates: { Pages: 'average' }, filters: [{ property: 'Pages', op: 'gt', value: 1000 }] });
		expect(empty.aggregates).toEqual({ Pages: { fn: 'average', value: null } });
	});

	it('rejects unknown properties, unknown functions and type violations with 400', () => {
		const store = setup();
		const id = library(store);
		expect(() => store.query(id, { group_by: { property: 'Nope' } })).toThrowError(/Unknown property "Nope"/);
		expect(() => store.query(id, { aggregates: { Nope: 'sum' } })).toThrowError(/Unknown property "Nope"/);
		expect(() => store.query(id, { aggregates: { Pages: 'median' as never } })).toThrowError(/must be one of/);
		expect(() => store.query(id, { aggregates: { Status: 'sum' } })).toThrowError(/not supported for "Status" \(select\)/);
		expect(() => store.query(id, { aggregates: { Pages: 'sum', Status: 'average' } })).toThrowError(/"average"/);
		const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`P${i}`, 'count'])) as never;
		expect(() => store.query(id, { aggregates: many })).toThrowError(/at most 20/);
		expect(() => store.query(id, { group_by: { property: 'Status', direction: 'sideways' } as never })).toThrowError(/asc or desc/);
	});
});

describe('views carry grouping', () => {
	it('saves, reads back and applies group_by and aggregates; explicit null disables them', () => {
		const store = setup();
		const id = library(store);
		const view = store.saveView(id, {
			name: 'By status',
			filters: [{ property: 'Pages', op: 'is_not_empty' }],
			group_by: { property: 'Status', direction: 'asc' },
			aggregates: { Pages: 'sum' }
		});
		expect(view).toMatchObject({ name: 'By status', group_by: { property: 'Status', direction: 'asc' }, aggregates: { Pages: 'sum' } });
		expect(store.views(id)[0]).toMatchObject({ id: view.id, group_by: { property: 'Status' }, aggregates: { Pages: 'sum' } });

		const viaView = store.query(id, { view: view.id });
		expect(viaView.groups).toEqual([
			{ key: 'a', count: 2 },
			{ key: 'b', count: 1 }
		]); // the view filter drops the empty row
		expect(viaView.aggregates).toEqual({ Pages: { fn: 'sum', value: 60 } });

		expect(store.query(id, { view: view.id, group_by: null, aggregates: null })).toMatchObject({ groups: null, aggregates: null });

		const overridden = store.query(id, { view: view.id, group_by: { property: 'Done' } });
		expect(overridden.groups!.map((g) => String(g.key))).toEqual(['false', 'true']);
		// overriding group_by keeps the view's aggregates: the two settings are independent
		expect(overridden.aggregates).toEqual({ Pages: { fn: 'sum', value: 60 } });
	});

	it('ignores dangling view group_by and aggregates after the property is deleted', () => {
		const store = setup();
		const id = library(store);
		const status = store.properties(id).find((p) => p.name === 'Status')!;
		const view = store.saveView(id, { name: 'V', group_by: { property: 'Status' }, aggregates: { Status: 'count_values', Pages: 'sum' } });
		store.deleteProperty(id, status.id);

		const q = store.query(id, { view: view.id });
		expect(q.groups).toBeNull(); // the group property is gone: grouping silently off
		expect(q.aggregates).toEqual({ Pages: { fn: 'sum', value: 60 } }); // the dangling Status entry is dropped, Pages survives
	});

	it('saveView validates group and aggregate properties against the collection', () => {
		const store = setup();
		const id = library(store);
		expect(() => store.saveView(id, { name: 'V', group_by: { property: 'Nope' } })).toThrowError(/Unknown property "Nope"/);
		expect(() => store.saveView(id, { name: 'V', aggregates: { Title: 'sum' } })).toThrowError(/not supported for "Title"/);
	});
});
