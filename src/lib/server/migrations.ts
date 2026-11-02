import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Ordered schema migrations for `collections.sqlite`.
 *
 * `PRAGMA user_version` is the applied version. Every step runs inside one transaction together
 * with its version bump, so a failing step leaves the database at the previous version. All
 * pending steps of a single run are committed together: a broken step also rolls back the steps
 * before it in the same run.
 *
 * Before the first write of a run the database is copied through SQLite (`.backup`), never as a
 * file copy: copying the main file while WAL is active can produce a torn snapshot. The backup is
 * written next to the database and is only skipped for a file that does not exist yet or for
 * `:memory:`.
 *
 * Adding a migration: append a step with the next version, never edit a published step. The SQL
 * must be idempotent where it touches pre-migration databases (see step 1, which also adopts
 * databases created before migrations existed).
 */

export interface Migration {
	/** Applied version after this step; strictly increasing, starting at 1. */
	version: number;
	/** Short, stable name used in logs and error messages. */
	name: string;
	/** SQL executed as one step. No transaction statements: the runner owns the transaction. */
	sql: string;
}

export class MigrationError extends Error {
	constructor(
		message: string,
		readonly version?: number
	) {
		super(message);
		this.name = 'MigrationError';
	}
}

export interface MigrationOptions {
	/** Report pending steps without writing, backing up or opening a write transaction. */
	dryRun?: boolean;
	/** Defaults to `console.info` unless NODE_ENV is `test`. */
	logger?: (line: string) => void;
	/** Test hook: run an alternative ordered list instead of MIGRATIONS. */
	migrations?: readonly Migration[];
	/** Set to false when the database file did not exist before this open. */
	backup?: boolean;
}

export interface MigrationResult {
	from: number;
	to: number;
	applied: Migration[];
	pending: Migration[];
	backupFile: string | null;
}

/** Current schema, created from scratch by step 1. Also the shape pre-migration databases have. */
export const BASELINE_SCHEMA = `
CREATE TABLE IF NOT EXISTS collection (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	icon TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS collection_name ON collection(name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS property (
	id TEXT PRIMARY KEY,
	collection_id TEXT NOT NULL REFERENCES collection(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	type TEXT NOT NULL,
	options TEXT,
	position INTEGER NOT NULL,
	UNIQUE (collection_id, name)
);
CREATE INDEX IF NOT EXISTS property_collection ON property(collection_id);
CREATE TABLE IF NOT EXISTS "row" (
	id TEXT PRIMARY KEY,
	collection_id TEXT NOT NULL REFERENCES collection(id) ON DELETE CASCADE,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	position INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS row_collection ON "row"(collection_id);
CREATE TABLE IF NOT EXISTS cell (
	row_id TEXT NOT NULL REFERENCES "row"(id) ON DELETE CASCADE,
	property_id TEXT NOT NULL REFERENCES property(id) ON DELETE CASCADE,
	value TEXT NOT NULL,
	PRIMARY KEY (row_id, property_id)
);
CREATE INDEX IF NOT EXISTS cell_property ON cell(property_id);
CREATE TABLE IF NOT EXISTS "view" (
	id TEXT PRIMARY KEY,
	collection_id TEXT NOT NULL REFERENCES collection(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	filters TEXT NOT NULL DEFAULT '[]',
	sorts TEXT NOT NULL DEFAULT '[]',
	columns TEXT,
	position INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS view_collection ON "view"(collection_id);
CREATE TABLE IF NOT EXISTS revision (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	collection_id TEXT NOT NULL,
	row_id TEXT,
	at TEXT NOT NULL,
	actor TEXT NOT NULL,
	op TEXT NOT NULL,
	before TEXT,
	after TEXT
);
CREATE INDEX IF NOT EXISTS revision_collection ON revision(collection_id, id);
`;

export const MIGRATIONS: readonly Migration[] = [
	{
		version: 1,
		name: 'baseline',
		sql: BASELINE_SCHEMA
	}
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

function defaultLogger(line: string): void {
	if (process.env.NODE_ENV === 'test') return;
	console.info(`[collections] ${line}`);
}

function validate(migrations: readonly Migration[]): void {
	let expected = 1;
	for (const migration of migrations) {
		if (migration.version !== expected) {
			throw new MigrationError(`Migration list is not contiguous: expected version ${expected}, got ${migration.version} (${migration.name})`);
		}
		if (!migration.name.trim()) throw new MigrationError(`Migration ${migration.version} has no name`);
		expected += 1;
	}
}

export function schemaVersion(db: DatabaseSync): number {
	const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
	return Number(row.user_version);
}

/** Pending steps for a database at `current`, in order. */
export function pendingMigrations(current: number, migrations: readonly Migration[] = MIGRATIONS): Migration[] {
	validate(migrations);
	return migrations.filter((migration) => migration.version > current);
}

/**
 * Copies `file` through the sqlite3 CLI (`.backup`) and verifies the snapshot opens. Throws before
 * any write when the CLI is missing or the copy fails, so a migration never runs without a backup.
 */
export function backupDatabase(file: string, target: string): string {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const quoted = target.replaceAll("'", "''");
	const result = spawnSync('sqlite3', [file], { input: `.backup '${quoted}'\n`, encoding: 'utf8' });
	if (result.error) throw new MigrationError(`Cannot back up ${file} through sqlite3: ${result.error.message}`);
	if (result.status !== 0) {
		const detail = (result.stderr || result.stdout || '').trim();
		throw new MigrationError(`Cannot back up ${file} through sqlite3${detail ? `: ${detail}` : ''}`);
	}
	if (!fs.existsSync(target) || fs.statSync(target).size === 0) {
		throw new MigrationError(`Backup of ${file} produced no file at ${target}`);
	}
	const snapshot = new DatabaseSync(target);
	try {
		// `.backup` copies the source's WAL journal mode; switch the snapshot to a self-contained
		// file so restoring it needs no -wal/-shm sidecars.
		snapshot.exec('PRAGMA journal_mode = DELETE;');
		const check = snapshot.prepare('PRAGMA quick_check').get() as { quick_check: string };
		if (check.quick_check !== 'ok') throw new MigrationError(`Backup of ${file} failed its integrity check: ${check.quick_check}`);
	} finally {
		snapshot.close();
	}
	return target;
}

export function backupPath(file: string, version: number, now = new Date()): string {
	const stamp = now.toISOString().replaceAll(/[:.]/g, '-');
	return `${file}.pre-migration-v${version}-${stamp}.bak`;
}

/**
 * Brings `db` to the latest version in one write transaction. Returns what happened; with
 * `dryRun` it only reports the pending steps.
 */
export function runMigrations(db: DatabaseSync, file: string, options: MigrationOptions = {}): MigrationResult {
	const migrations = options.migrations ?? MIGRATIONS;
	const log = options.logger ?? defaultLogger;
	const current = schemaVersion(db);
	const target = migrations.length ? migrations[migrations.length - 1].version : 0;
	validate(migrations);

	if (current > target) {
		throw new MigrationError(
			`${file} is at schema version ${current}, but this build only knows version ${target}. Refusing to run an older binary against a newer database.`
		);
	}

	const pending = pendingMigrations(current, migrations);
	if (pending.length === 0) {
		return { from: current, to: current, applied: [], pending: [], backupFile: null };
	}

	if (options.dryRun) {
		for (const migration of pending) log(`pending v${migration.version} ${migration.name} (dry run, nothing written)`);
		log(`dry run: ${pending.length} pending step(s), schema stays at v${current}`);
		return { from: current, to: current, applied: [], pending, backupFile: null };
	}

	let backupFile: string | null = null;
	if (file !== ':memory:' && options.backup !== false) {
		backupFile = backupDatabase(file, backupPath(file, current));
		log(`backup of schema v${current} written to ${backupFile}`);
	}

	db.exec('BEGIN IMMEDIATE');
	try {
		for (const migration of pending) {
			try {
				db.exec(migration.sql);
			} catch (e) {
				throw new MigrationError(`Migration v${migration.version} (${migration.name}) failed: ${(e as Error).message}`, migration.version);
			}
			db.exec(`PRAGMA user_version = ${migration.version}`);
		}
		db.exec('COMMIT');
	} catch (e) {
		try {
			db.exec('ROLLBACK');
		} catch {
			/* already rolled back */
		}
		throw e;
	}

	for (const migration of pending) log(`applied v${migration.version} ${migration.name}`);
	log(`schema v${current} -> v${target}`);

	return { from: current, to: target, applied: pending, pending, backupFile };
}
