import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CollectionStore, type BulkTarget } from '../src/lib/server/collections';

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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stichpunkt-bulk-'));
	const store = CollectionStore.open(path.join(dir, 'collections.sqlite'));
	open.push(store);
	return store;
}

/** Wishlist with a title, a select, a checkbox and a free text note. */
function seeded(count = 3) {
	const store = setup();
	const c = store.create({
		name: 'Wunschliste',
		properties: [
			{ name: 'Titel', type: 'title' },
			{ name: 'Status', type: 'select', options: ['offen', 'erledigt'] },
			{ name: 'Erledigt', type: 'checkbox' },
			{ name: 'Notiz', type: 'text' }
		]
	});
	const rows = Array.from({ length: count }, (_, i) => store.createRow(c.id, { Titel: `R${i + 1}`, Status: 'offen', Notiz: `n${i + 1}` }));
	return { store, c, rows };
}

const targets = (rows: { id: string; updated_at: string }[], withBase = true): BulkTarget[] =>
	rows.map((r) => (withBase ? { row_id: r.id, base_updated_at: r.updated_at } : { row_id: r.id }));

const statusOf = (store: CollectionStore, id: string) =>
	store
		.query(id)
		.rows.map((r) => r.values.Status);

describe('bulk edit', () => {
	it('applies one patch to every row as a single batch', () => {
		const { store, c, rows } = seeded();
		const res = store.bulkUpdate(c.id, { rows: targets(rows), values: { Status: 'erledigt', Erledigt: true }, actor: 'api' });
		expect(res).toMatchObject({ updated: 3 });
		expect(res.batch_id).toMatch(/^[0-9a-f-]{36}$/);
		const after = store.query(c.id).rows;
		expect(after.map((r) => r.values.Status)).toEqual(['erledigt', 'erledigt', 'erledigt']);
		expect(after.map((r) => r.values.Erledigt)).toEqual([true, true, true]);
		expect(after.map((r) => r.values.Notiz)).toEqual(['n1', 'n2', 'n3']); // untouched properties stay
		expect(new Set(after.map((r) => r.updated_at)).size).toBe(1); // one timestamp for the batch
	});

	it('records one revision per row under a shared batch_id', () => {
		const { store, c, rows } = seeded();
		const res = store.bulkUpdate(c.id, { rows: targets(rows), values: { Status: 'erledigt' } });
		const hist = store.history(c.id);
		expect(hist.filter((h) => h.batch_id === res.batch_id)).toHaveLength(3);
		expect(hist.filter((h) => h.batch_id === res.batch_id).every((h) => h.op === 'update' && h.undo_of === null)).toBe(true);
		const one = hist.find((h) => h.row_id === rows[0].id)!;
		expect(one.before).toMatchObject({ Status: 'offen' });
		expect(one.after).toMatchObject({ Status: 'erledigt' });
		expect(store.history(c.id, rows[0].id).filter((h) => h.op !== 'create').every((h) => h.batch_id === res.batch_id)).toBe(true);
	});

	it('null clears a cell in every row', () => {
		const { store, c, rows } = seeded();
		store.bulkUpdate(c.id, { rows: targets(rows), values: { Notiz: null } });
		expect(store.query(c.id).rows.every((r) => r.values.Notiz === undefined)).toBe(true);
	});

	it('collapses duplicate row ids', () => {
		const { store, c, rows } = seeded();
		const res = store.bulkUpdate(c.id, { rows: [...targets(rows), { row_id: rows[0].id }], values: { Status: 'erledigt' } });
		expect(res.updated).toBe(3);
		expect(store.history(c.id).filter((h) => h.batch_id === res.batch_id)).toHaveLength(3);
	});

	it('dry runs report would_update and write nothing', () => {
		const { store, c, rows } = seeded();
		const before = store.query(c.id).rows.map((r) => r.updated_at);
		const dry = store.bulkUpdate(c.id, { rows: targets(rows), values: { Status: 'erledigt' }, dryRun: true });
		expect(dry).toMatchObject({ updated: 0, would_update: 3 });
		expect(store.history(c.id).some((h) => h.batch_id)).toBe(false);
		expect(store.query(c.id).rows.map((r) => r.updated_at)).toEqual(before);
		expect(statusOf(store, c.id)).toEqual(['offen', 'offen', 'offen']);
	});

	it('rejects empty input and over-sized batches', () => {
		const { store, c, rows } = seeded();
		expect(() => store.bulkUpdate(c.id, { rows: [], values: { Status: 'erledigt' } })).toThrowError(/at least one row/);
		expect(() => store.bulkUpdate(c.id, { rows: targets(rows), values: {} })).toThrowError(/at least one property/);
		expect(() => store.bulkUpdate(c.id, { rows: targets(rows), values: 'x' })).toThrowError(/values must be an object/);
		const many = Array.from({ length: 501 }, (_, i) => ({ row_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }));
		expect(() => store.bulkUpdate(c.id, { rows: many, values: { Status: 'erledigt' } })).toThrowError(/at most 500/);
	});

	it('validates values against the property types before writing anything', () => {
		const { store, c, rows } = seeded();
		const err = () => store.bulkUpdate(c.id, { rows: targets(rows), values: { Status: 'falsch' } });
		expect(err).toThrowError(/Status/);
		expect(statusOf(store, c.id)).toEqual(['offen', 'offen', 'offen']);
		expect(() => store.bulkUpdate(c.id, { rows: targets(rows), values: { Unknown: 'x' } })).toThrowError(/Unknown property/);
	});

	it('404s on an unknown row and changes nothing', () => {
		const { store, c, rows } = seeded();
		const e = store.bulkUpdate.bind(store);
		expect(() => e(c.id, { rows: [{ row_id: 'nope' }], values: { Status: 'erledigt' } })).toThrowError(/nope|not found|does not exist/i);
		expect(statusOf(store, c.id)).toEqual(['offen', 'offen', 'offen']);
	});

	it('aborts the whole batch on a stale base_updated_at and names the row', () => {
		const { store, c, rows } = seeded();
		const stale = store.getRow(c.id, rows[1].id);
		store.updateRow(c.id, rows[1].id, { Notiz: 'von Hand' }, 'someone', stale.updated_at);
		const moved = store.getRow(c.id, rows[1].id);
		try {
			store.bulkUpdate(c.id, { rows: [{ row_id: rows[0].id, base_updated_at: rows[0].updated_at }, { row_id: rows[1].id, base_updated_at: '2000-01-01T00:00:00.000Z' }], values: { Status: 'erledigt' } });
			expect.unreachable();
		} catch (e) {
			const err = e as { status: number; message: string; details: Record<string, unknown> };
			expect(err.status).toBe(409);
			expect(err.message).toBe('Row "R2" changed since it was loaded');
			expect(err.details).toMatchObject({ row_id: rows[1].id, title: 'R2', current: moved.updated_at });
		}
		expect(statusOf(store, c.id)).toEqual(['offen', 'offen', 'offen']);
	});

	it('names a row without a title (untitled) in the conflict', () => {
		const { store, c, rows } = seeded(2);
		store.updateRow(c.id, rows[0].id, { Titel: '' });
		try {
			store.bulkUpdate(c.id, { rows: [{ row_id: rows[0].id, base_updated_at: '2000-01-01T00:00:00.000Z' }], values: { Status: 'erledigt' } });
			expect.unreachable();
		} catch (e) {
			expect((e as { message: string }).message).toBe('Row "(untitled)" changed since it was loaded');
		}
	});
});

describe('undo batch', () => {
	it('restores every row to what it held before the batch', () => {
		const { store, c, rows } = seeded();
		store.updateRow(c.id, rows[1].id, { Status: 'erledigt' }); // row 2 already erledigt before the batch
		const bulk = store.bulkUpdate(c.id, { rows: targets(store.query(c.id).rows), values: { Status: 'erledigt' } });
		const undo = store.undoBatch(c.id, bulk.batch_id, 'web-ui');
		expect(undo).toMatchObject({ undone: 3 });
		expect(undo.batch_id).not.toBe(bulk.batch_id);
		const after = store.query(c.id).rows;
		expect(after.map((r) => r.values.Status)).toEqual(['offen', 'erledigt', 'offen']); // per-row values, not one blanket value
		const rev = store.history(c.id, rows[0].id)[0];
		expect(rev).toMatchObject({ batch_id: undo.batch_id, undo_of: bulk.batch_id, actor: 'web-ui' });
	});

	it('dry runs report would_undo under the source batch id and write nothing', () => {
		const { store, c, rows } = seeded();
		const bulk = store.bulkUpdate(c.id, { rows: targets(rows), values: { Status: 'erledigt' } });
		const dry = store.undoBatch(c.id, bulk.batch_id, 'api', true);
		expect(dry).toMatchObject({ batch_id: bulk.batch_id, undone: 0, would_undo: 3 });
		expect(statusOf(store, c.id)).toEqual(['erledigt', 'erledigt', 'erledigt']);
		expect(store.batches(c.id).find((b) => b.batch_id === bulk.batch_id)?.undone).toBe(false);
	});

	it('a batch can only be undone once', () => {
		const { store, c, rows } = seeded();
		const bulk = store.bulkUpdate(c.id, { rows: targets(rows), values: { Status: 'erledigt' } });
		store.undoBatch(c.id, bulk.batch_id);
		expect(() => store.undoBatch(c.id, bulk.batch_id)).toThrowError(/already undone/);
	});

	it('blocks when a batch property moved on since the batch and changes nothing', () => {
		const { store, c, rows } = seeded();
		const bulk = store.bulkUpdate(c.id, { rows: targets(rows), values: { Status: 'erledigt' } });
		const moved = store.getRow(c.id, rows[2].id);
		store.updateRow(c.id, rows[2].id, { Status: 'offen' }, 'api', moved.updated_at);
		try {
			store.undoBatch(c.id, bulk.batch_id);
			expect.unreachable();
		} catch (e) {
			const err = e as { status: number; message: string; details: Record<string, unknown> };
			expect(err.status).toBe(409);
			expect(err.message).toBe('Row "R3" changed since it was loaded');
			expect(err.details).toMatchObject({ row_id: rows[2].id, title: 'R3', current: store.getRow(c.id, rows[2].id).updated_at });
		}
		expect(statusOf(store, c.id)).toEqual(['erledigt', 'erledigt', 'offen']); // the batch stands, the manual edit stands, nothing was rolled back
	});

	it('leaves later edits to other properties alone when undoing', () => {
		const { store, c, rows } = seeded();
		const bulk = store.bulkUpdate(c.id, { rows: targets(rows), values: { Status: 'erledigt' } });
		const moved = store.getRow(c.id, rows[2].id);
		store.updateRow(c.id, rows[2].id, { Notiz: 'später editiert' }, 'api', moved.updated_at);
		expect(store.undoBatch(c.id, bulk.batch_id).undone).toBe(3);
		expect(statusOf(store, c.id)).toEqual(['offen', 'offen', 'offen']);
		expect(store.getRow(c.id, rows[2].id).values.Notiz).toBe('später editiert');
	});

	it('blocks with current null when a row was deleted', () => {
		const { store, c, rows } = seeded();
		const bulk = store.bulkUpdate(c.id, { rows: targets(rows), values: { Status: 'erledigt' } });
		store.deleteRow(c.id, rows[0].id);
		try {
			store.undoBatch(c.id, bulk.batch_id);
			expect.unreachable();
		} catch (e) {
			const err = e as { status: number; message: string; details: Record<string, unknown> };
			expect(err.status).toBe(409);
			expect(err.message).toBe('Row "R1" changed since it was loaded');
			expect(err.details).toMatchObject({ row_id: rows[0].id, title: 'R1', current: null });
		}
		expect(store.query(c.id).rows.map((r) => r.values.Status)).toEqual(['erledigt', 'erledigt']);
	});

	it('ignores properties the collection lost in the meantime', () => {
		const { store, c, rows } = seeded();
		const bulk = store.bulkUpdate(c.id, { rows: targets(rows), values: { Status: 'erledigt' } });
		const statusProp = store.properties(c.id).find((p) => p.name === 'Status')!;
		store.deleteProperty(c.id, statusProp.id);
		const undo = store.undoBatch(c.id, bulk.batch_id);
		expect(undo.undone).toBe(3);
		expect(store.query(c.id).rows.every((r) => r.values.Status === undefined)).toBe(true);
	});

	it('undoing an undo re-applies the change', () => {
		const { store, c, rows } = seeded();
		const bulk = store.bulkUpdate(c.id, { rows: targets(rows), values: { Status: 'erledigt' } });
		const undo = store.undoBatch(c.id, bulk.batch_id);
		expect(statusOf(store, c.id)).toEqual(['offen', 'offen', 'offen']);
		const redo = store.undoBatch(c.id, undo.batch_id);
		expect(redo.undone).toBe(3);
		expect(statusOf(store, c.id)).toEqual(['erledigt', 'erledigt', 'erledigt']);
		expect(store.batches(c.id)[0]).toMatchObject({ batch_id: redo.batch_id, undone: false });
	});

	it('404s for an unknown batch', () => {
		const { store, c } = seeded();
		expect(() => store.undoBatch(c.id, 'nope')).toThrowError(/does not exist/);
	});
});

describe('batches summary', () => {
	it('lists batches newest first with actor, row count and undone flag', () => {
		const { store, c, rows } = seeded();
		expect(store.batches(c.id)).toEqual([]); // single-row edits never make a batch
		const first = store.bulkUpdate(c.id, { rows: targets(rows.slice(0, 2)), values: { Status: 'erledigt' }, actor: 'api' });
		const second = store.bulkUpdate(c.id, { rows: targets(store.query(c.id).rows), values: { Notiz: 'einheitlich' }, actor: 'mcp' });
		const undo = store.undoBatch(c.id, first.batch_id, 'web-ui');
		const list = store.batches(c.id);
		expect(list.map((b) => b.batch_id)).toEqual([undo.batch_id, second.batch_id, first.batch_id]); // the undo is a batch of its own
		expect(list[0]).toMatchObject({ actor: 'web-ui', row_count: 2, undone: false });
		expect(list[1]).toMatchObject({ actor: 'mcp', row_count: 3, undone: false });
		expect(list[2]).toMatchObject({ actor: 'api', row_count: 2, undone: true });
		expect(list[0].at).toMatch(/Z$/);
		expect(store.batches(c.id, 1)).toHaveLength(1);
	});

	it('filters history by batch_id', () => {
		const { store, c, rows } = seeded();
		const a = store.bulkUpdate(c.id, { rows: targets(rows.slice(0, 1)), values: { Status: 'erledigt' } });
		const b = store.bulkUpdate(c.id, { rows: targets(rows.slice(1)), values: { Status: 'erledigt' } });
		expect(store.history(c.id, undefined, 50, a.batch_id).map((h) => h.row_id)).toEqual([rows[0].id]);
		expect(store.history(c.id, undefined, 50, b.batch_id)).toHaveLength(2);
	});
});
