import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { CollectionStore } from '../src/lib/server/collections';
import {
	BASELINE_SCHEMA,
	MIGRATIONS,
	MigrationError,
	backupPath,
	pendingMigrations,
	runMigrations,
	schemaVersion,
	type Migration
} from '../src/lib/server/migrations';

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stichpunkt-migrations-'));
	dirs.push(dir);
	return dir;
}

function legacyDatabase(file: string): void {
	const db = new DatabaseSync(file);
	db.exec(BASELINE_SCHEMA);
	db.prepare('INSERT INTO collection (id, name, icon, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
		'c1',
		'Bücher',
		null,
		'2026-01-01T00:00:00.000Z',
		'2026-01-01T00:00:00.000Z'
	);
	db.prepare('INSERT INTO property (id, collection_id, name, type, options, position) VALUES (?, ?, ?, ?, ?, ?)').run(
		'p1',
		'c1',
		'Titel',
		'title',
		null,
		0
	);
	db.prepare('INSERT INTO "row" (id, collection_id, created_at, updated_at, position) VALUES (?, ?, ?, ?, ?)').run(
		'r1',
		'c1',
		'2026-01-01T00:00:00.000Z',
		'2026-01-01T00:00:00.000Z',
		0
	);
	db.prepare('INSERT INTO cell (row_id, property_id, value) VALUES (?, ?, ?)').run('r1', 'p1', JSON.stringify('Die Welt'));
	db.close();
}

function backups(file: string): string[] {
	return fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith(path.basename(file) + '.pre-migration-') && name.endsWith('.bak'));
}

describe('schema migrations', () => {
	it('creates a fresh database at the current version and is a no-op on the next run', () => {
		const file = path.join(workspace(), 'collections.sqlite');
		const lines: string[] = [];

		const first = runMigrations(new DatabaseSync(file), file, { backup: false, logger: (line) => lines.push(line) });
		expect(first).toMatchObject({ from: 0, to: 1, backupFile: null });
		expect(first.applied.map((m) => m.version)).toEqual([1]);
		expect(lines).toContain('applied v1 baseline');
		expect(schemaVersion(new DatabaseSync(file))).toBe(1);

		const second = runMigrations(new DatabaseSync(file), file, { logger: (line) => lines.push(line) });
		expect(second).toMatchObject({ from: 1, to: 1, applied: [], pending: [] });
		expect(schemaVersion(new DatabaseSync(file))).toBe(1);
		expect(backups(file)).toHaveLength(0);
	});

	it('opens a store twice without error and keeps rows', () => {
		const file = path.join(workspace(), 'collections.sqlite');
		const store = CollectionStore.open(file);
		const books = store.create({ name: 'Bücher', properties: [{ name: 'Titel', type: 'title' }] });
		store.createRow(books.id, { Titel: 'Die Welt' });
		store.close();

		const reopened = CollectionStore.open(file);
		expect(reopened.list()).toHaveLength(1);
		expect(reopened.query(books.id).total).toBe(1);
		reopened.close();

		const db = new DatabaseSync(file);
		expect(schemaVersion(db)).toBe(1);
		db.close();
	});

	it('adopts a pre-migration database without touching its rows and backs it up first', () => {
		const file = path.join(workspace(), 'collections.sqlite');
		legacyDatabase(file);
		expect(schemaVersion(new DatabaseSync(file))).toBe(0);

		const store = CollectionStore.open(file);
		expect(store.list()).toMatchObject([{ id: 'c1', name: 'Bücher', row_count: 1 }]);
		expect(store.query('c1').rows[0].values).toEqual({ Titel: 'Die Welt' });
		store.close();

		expect(schemaVersion(new DatabaseSync(file))).toBe(1);
		const copies = backups(file);
		expect(copies).toHaveLength(1);

		const snapshot = new DatabaseSync(path.join(path.dirname(file), copies[0]), { readOnly: true });
		expect((snapshot.prepare('SELECT count(*) AS n FROM "row"').get() as { n: number }).n).toBe(1);
		snapshot.close();
	});

	it('reports pending steps in a dry run without writing or backing up', () => {
		const file = path.join(workspace(), 'collections.sqlite');
		legacyDatabase(file);
		const lines: string[] = [];

		const result = runMigrations(new DatabaseSync(file), file, { dryRun: true, logger: (line) => lines.push(line) });

		expect(result).toMatchObject({ from: 0, to: 0, applied: [], backupFile: null });
		expect(result.pending.map((m) => m.version)).toEqual([1]);
		expect(lines.join('\n')).toMatch(/pending v1 baseline \(dry run, nothing written\)/);
		expect(schemaVersion(new DatabaseSync(file))).toBe(0);
		expect(backups(file)).toHaveLength(0);
	});

	it('rolls back every step of a run when one migration is broken', () => {
		const file = path.join(workspace(), 'collections.sqlite');
		legacyDatabase(file);
		runMigrations(new DatabaseSync(file), file);
		const before = backups(file).length;

		const broken: Migration[] = [
			...MIGRATIONS,
			{
				version: 2,
				name: 'half-written',
				sql: 'CREATE TABLE scratch (id TEXT); INSERT INTO missing_table (id) VALUES (1);'
			},
			{ version: 3, name: 'never-reached', sql: 'CREATE TABLE later (id TEXT);' }
		];

		expect(() => runMigrations(new DatabaseSync(file), file, { migrations: broken })).toThrowError(/Migration v2 \(half-written\) failed/);
		expect(schemaVersion(new DatabaseSync(file))).toBe(1);

		const db = new DatabaseSync(file);
		const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
		expect(tables).not.toContain('scratch');
		expect(tables).not.toContain('later');
		expect((db.prepare('SELECT count(*) AS n FROM "row"').get() as { n: number }).n).toBe(1);
		expect((db.prepare('SELECT value FROM cell WHERE row_id = ?').get('r1') as { value: string }).value).toBe(JSON.stringify('Die Welt'));
		db.close();

		const copies = backups(file);
		expect(copies).toHaveLength(before + 1);
		const snapshot = new DatabaseSync(path.join(path.dirname(file), copies.at(-1)!), { readOnly: true });
		expect((snapshot.prepare('SELECT count(*) AS n FROM "row"').get() as { n: number }).n).toBe(1);
		snapshot.close();
	});

	it('applies a later version once and records it in user_version', () => {
		const file = path.join(workspace(), 'collections.sqlite');
		legacyDatabase(file);
		runMigrations(new DatabaseSync(file), file);

		const next: Migration[] = [...MIGRATIONS, { version: 2, name: 'add-index', sql: 'CREATE INDEX cell_value ON cell(value);' }];
		const lines: string[] = [];
		const result = runMigrations(new DatabaseSync(file), file, { migrations: next, logger: (line) => lines.push(line) });

		expect(result).toMatchObject({ from: 1, to: 2 });
		expect(result.applied.map((m) => m.name)).toEqual(['add-index']);
		expect(lines).toContain('applied v2 add-index');
		expect(schemaVersion(new DatabaseSync(file))).toBe(2);

		const again = runMigrations(new DatabaseSync(file), file, { migrations: next, logger: (line) => lines.push(line) });
		expect(again.applied).toEqual([]);
		expect(backups(file)).toHaveLength(2);
	});

	it('refuses a database newer than the build and a non-contiguous list', () => {
		const file = path.join(workspace(), 'collections.sqlite');
		const db = new DatabaseSync(file);
		db.exec(BASELINE_SCHEMA);
		db.exec('PRAGMA user_version = 9');

		expect(() => runMigrations(db, file)).toThrowError(MigrationError);
		expect(() => runMigrations(db, file)).toThrowError(/newer database/);
		expect(() =>
			pendingMigrations(0, [
				{ version: 1, name: 'a', sql: '' },
				{ version: 3, name: 'b', sql: '' }
			])
		).toThrowError(/not contiguous/);
		db.close();
	});

	it('names backups after the schema version they protect', () => {
		const file = '/tmp/collections.sqlite';
		expect(backupPath(file, 3, new Date('2026-11-02T10:11:12.345Z'))).toBe('/tmp/collections.sqlite.pre-migration-v3-2026-11-02T10-11-12-345Z.bak');
	});
});
