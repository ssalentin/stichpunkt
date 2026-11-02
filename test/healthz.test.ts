import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CollectionStore } from '../src/lib/server/collections';
import {
	checkBackup,
	checkDatabase,
	checkDeployed,
	checkWrite,
	lastBackupAt,
	runHealthChecks
} from '../src/lib/server/health';
import { GET } from '../src/routes/healthz/+server';

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stichpunkt-health-'));
});

const stores: CollectionStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) {
		try {
			store.close();
		} catch {
			/* already closed */
		}
	}
	fs.rmSync(dir, { recursive: true, force: true });
});

/** A real database with one collection, so the write probe has something to lock. */
function seedDb(): string {
	const file = path.join(dir, 'collections.sqlite');
	const store = CollectionStore.open(file);
	store.create({ name: 'Smoke', properties: [{ name: 'Titel', type: 'title' }] });
	store.close();
	return file;
}

function writeBackupLog(contents: string): string {
	const file = path.join(dir, 'backup.log');
	fs.writeFileSync(file, contents);
	return file;
}

function writeSha(sha: string): string {
	const file = path.join(dir, 'deployed.sha');
	fs.writeFileSync(file, `${sha}\n`);
	return file;
}

const NOW = new Date('2026-11-02T13:00:00');
const FRESH_BACKUP = 'backup ok 2026-11-02_1200 (incl. /etc, knowledgebase, openbot-mailan)\n';

describe('health checks', () => {
	it('returns 200 when the database is intact and writable, the commit is known and the backup is fresh', () => {
		const report = runHealthChecks({
			collectionsDb: seedDb(),
			deployedShaFile: writeSha('45996c4deadbeef'),
			backupLog: writeBackupLog(FRESH_BACKUP),
			now: NOW
		});

		expect(report.status).toBe(200);
		expect(report.body.status).toBe('ok');
		expect(report.body.checked_at).toBe(NOW.toISOString());
		expect(report.body.checks.database).toEqual({ ok: true, integrity: 'ok', schema_version: 0 });
		expect(report.body.checks.write).toEqual({ ok: true, mode: 'begin_immediate_rollback' });
		expect(report.body.checks.deployed).toMatchObject({ ok: true, present: true, sha: '45996c4deadbeef' });
		expect(report.body.checks.backup).toMatchObject({ ok: true, age_seconds: 3600, max_age_seconds: 129600 });
	});

	it('returns 503 for a missing database without leaking the path', () => {
		const report = runHealthChecks({
			collectionsDb: path.join(dir, 'nope.sqlite'),
			deployedShaFile: writeSha('abc'),
			backupLog: writeBackupLog(FRESH_BACKUP),
			now: NOW
		});

		expect(report.status).toBe(503);
		expect(report.body.status).toBe('fail');
		expect(report.body.checks.database).toEqual({ ok: false, error: 'database_missing' });
		expect(report.body.checks.write).toEqual({ ok: false, mode: 'begin_immediate_rollback', error: 'database_missing' });
		expect(JSON.stringify(report.body)).not.toContain(dir);
	});

	it('returns 503 for a corrupt database file', () => {
		const file = path.join(dir, 'collections.sqlite');
		fs.writeFileSync(file, 'this is not a sqlite database, just bytes\n'.repeat(20));

		const database = checkDatabase(file);
		expect(database.ok).toBe(false);
		expect(database.error ?? database.integrity).toBeTruthy();

		const report = runHealthChecks({
			collectionsDb: file,
			deployedShaFile: writeSha('abc'),
			backupLog: writeBackupLog(FRESH_BACKUP),
			now: NOW
		});
		expect(report.status).toBe(503);
	});

	it('treats a missing deployed.sha as a field, not a failure', () => {
		const report = runHealthChecks({
			collectionsDb: seedDb(),
			deployedShaFile: path.join(dir, 'absent.sha'),
			backupLog: writeBackupLog(FRESH_BACKUP),
			now: NOW
		});

		expect(report.status).toBe(200);
		expect(report.body.checks.deployed).toEqual({ ok: true, present: false });
		expect(checkDeployed(path.join(dir, 'absent.sha'), NOW)).toEqual({ ok: true, present: false });
	});

	it('returns 503 when the last backup is too old or there is no record', () => {
		const stale = runHealthChecks({
			collectionsDb: seedDb(),
			deployedShaFile: writeSha('abc'),
			backupLog: writeBackupLog('backup ok 2026-10-30_1200 (incl. /etc)\n'),
			now: NOW
		});
		expect(stale.status).toBe(503);
		expect(stale.body.checks.backup).toMatchObject({ ok: false, age_seconds: 73 * 3600 });

		const none = checkBackup(path.join(dir, 'missing.log'), NOW);
		expect(none).toEqual({ ok: false, max_age_seconds: 129600, error: 'no_backup_record' });
	});

	it('reads the last successful backup line, skipping warnings and failures', () => {
		const log = writeBackupLog(
			[
				'backup ok 2026-11-01_0300 (incl. /etc)',
				'backup WARN: notion export stale (40h) at 2026-11-02_0300',
				'rsync error: some files could not be transferred',
				''
			].join('\n')
		);
		const last = lastBackupAt(log);
		expect(last?.raw).toBe('backup ok 2026-11-01_0300');
		expect(last?.at.getHours()).toBe(3);
	});

	it('proves the write path without changing data', () => {
		const file = seedDb();
		const before = checkDatabase(file);
		expect(checkWrite(file)).toEqual({ ok: true, mode: 'begin_immediate_rollback' });
		expect(checkDatabase(file)).toEqual(before);

		const store = CollectionStore.open(file);
		stores.push(store);
		expect(store.list()).toHaveLength(1);
		expect(store.list()[0].row_count).toBe(0);
	});
});

describe('GET /healthz', () => {
	const saved = { ...process.env };
	afterEach(() => {
		for (const key of ['COLLECTIONS_DB', 'DEPLOYED_SHA_FILE', 'BACKUP_LOG'] as const) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	});

	const call = () => GET({} as Parameters<typeof GET>[0]);

	it('answers 200 with named checks when everything is healthy', async () => {
		process.env.COLLECTIONS_DB = seedDb();
		process.env.DEPLOYED_SHA_FILE = writeSha('abc123');
		process.env.BACKUP_LOG = writeBackupLog(`backup ok ${new Date().toISOString().slice(0, 10)}_0000\n`);

		const res = await call();
		const body = (await res.json()) as Record<string, unknown>;
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(body.status).toBe('ok');
		expect(Object.keys(body.checks as object).sort()).toEqual(['backup', 'database', 'deployed', 'write']);
	});

	it('answers 503 when the database file is gone', async () => {
		process.env.COLLECTIONS_DB = path.join(dir, 'gone.sqlite');
		process.env.DEPLOYED_SHA_FILE = writeSha('abc123');
		process.env.BACKUP_LOG = writeBackupLog(FRESH_BACKUP);

		const res = await call();
		expect(res.status).toBe(503);
		expect((await res.json()).status).toBe('fail');
	});
});
