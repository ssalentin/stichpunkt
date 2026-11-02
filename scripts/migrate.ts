import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { collectionsFile } from '../src/lib/server/collections-path';
import { MIGRATIONS, SCHEMA_VERSION, pendingMigrations, runMigrations, schemaVersion } from '../src/lib/server/migrations';

/**
 * `npm run migrate -- [--dry-run] [--db <path>]`
 *
 * The server migrates on boot as well; this CLI is the operator path to inspect pending steps and
 * to migrate a database while the service is stopped. `--dry-run` never creates or writes a file.
 */

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

const dryRun = process.argv.includes('--dry-run');
const file = path.resolve(arg('--db') || collectionsFile(''));
const existed = fs.existsSync(file);

if (!existed) {
	if (dryRun) {
		for (const migration of pendingMigrations(0)) {
			console.info(`pending v${migration.version} ${migration.name} (dry run, no database at ${file})`);
		}
		console.info(`dry run: ${MIGRATIONS.length} pending step(s), schema would be v${SCHEMA_VERSION}`);
		process.exit(0);
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
}

const db = new DatabaseSync(file);
try {
	if (!dryRun) {
		db.exec('PRAGMA journal_mode = WAL;');
		db.exec('PRAGMA foreign_keys = ON;');
		db.exec('PRAGMA busy_timeout = 5000;');
	}
	const result = runMigrations(db, file, { dryRun, backup: !dryRun && existed });
	if (dryRun && result.pending.length === 0) console.info(`schema v${schemaVersion(db)} is current at ${file}`);
	if (!dryRun) {
		console.info(`schema v${result.from} -> v${schemaVersion(db)} at ${file}`);
		if (result.backupFile) console.info(`backup: ${result.backupFile}`);
	}
} catch (e) {
	console.error(`migration failed: ${(e as Error).message}`);
	process.exitCode = 1;
} finally {
	db.close();
}
