import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { collectionsFile } from './collections';

/**
 * Health checks behind `GET /healthz`.
 *
 * The deploy script used to prove only that pages return 200, which says nothing about the state of
 * the collections database or the last backup. This module reports four named checks and lets the
 * route turn them into 200/503:
 *
 * - `database`: `PRAGMA integrity_check` plus the schema version (`PRAGMA user_version`).
 * - `write`: a `BEGIN IMMEDIATE` / `ROLLBACK` probe. It takes the write lock and releases it again,
 *   so a read-only or locked database fails without touching a single row.
 * - `deployed`: the commit in `deployed.sha`, reported as a field. A missing file is not a failure,
 *   because a fresh checkout has never been deployed.
 * - `backup`: age of the last successful run recorded in the backup log.
 *
 * No filesystem paths, tokens or row contents leave this module. The endpoint is public, so the
 * report is limited to booleans, counters, timestamps and a commit hash.
 */

export const HEALTH_CHECK_TIMEOUT_MS = 5_000;

export interface HealthOptions {
	/** SQLite file of the collections store; defaults to `COLLECTIONS_DB`. */
	collectionsDb?: string;
	/** File holding the deployed commit; defaults to `DEPLOYED_SHA_FILE` or the service state dir. */
	deployedShaFile?: string;
	/** Log with `backup ok <stamp>` lines; defaults to `BACKUP_LOG`. */
	backupLog?: string;
	/** A backup older than this fails the check. Default 36 hours. */
	maxBackupAgeSeconds?: number;
	now?: Date;
}

export interface DatabaseCheck {
	ok: boolean;
	integrity?: string;
	schema_version?: number;
	error?: string;
}

export interface WriteCheck {
	ok: boolean;
	mode: 'begin_immediate_rollback';
	error?: string;
}

export interface DeployedCheck {
	ok: boolean;
	present: boolean;
	sha?: string;
	age_seconds?: number;
}

export interface BackupCheck {
	ok: boolean;
	last_at?: string;
	age_seconds?: number;
	max_age_seconds: number;
	error?: string;
}

export interface HealthReport {
	status: 'ok' | 'fail';
	checked_at: string;
	checks: {
		database: DatabaseCheck;
		write: WriteCheck;
		deployed: DeployedCheck;
		backup: BackupCheck;
	};
}

const DEPLOYED_SHA_DEFAULT = '/var/lib/stichpunkt/deployed.sha';
const BACKUP_LOG_DEFAULT = '/var/lib/openbot/backup.log';
const DEFAULT_MAX_BACKUP_AGE_SECONDS = 36 * 60 * 60;

function shaFile(opts: HealthOptions): string {
	return opts.deployedShaFile ?? process.env.DEPLOYED_SHA_FILE ?? DEPLOYED_SHA_DEFAULT;
}

function backupLogFile(opts: HealthOptions): string {
	return opts.backupLog ?? process.env.BACKUP_LOG ?? BACKUP_LOG_DEFAULT;
}

function configuredMaxBackupAgeSeconds(opts: HealthOptions): number {
	if (opts.maxBackupAgeSeconds !== undefined) return opts.maxBackupAgeSeconds;
	const configured = Number.parseInt(process.env.HEALTHZ_MAX_BACKUP_AGE_SECONDS ?? '', 10);
	return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_BACKUP_AGE_SECONDS;
}

function ageSeconds(mtimeMs: number, now: Date): number {
	return Math.max(0, Math.round((now.getTime() - mtimeMs) / 1000));
}

function errorCode(e: unknown): string {
	const message = e instanceof Error ? e.message : String(e);
	if (/locked|busy/i.test(message)) return 'database_locked';
	if (/readonly|read-only|permission|EACCES|EPERM/i.test(message)) return 'database_not_writable';
	if (/ENOENT/i.test(message)) return 'database_missing';
	return 'database_error';
}

/** Opens the collections file read-only and asks SQLite for its own verdict. */
export function checkDatabase(file: string): DatabaseCheck {
	if (!fs.existsSync(file)) return { ok: false, error: 'database_missing' };
	let db: DatabaseSync | undefined;
	try {
		db = new DatabaseSync(file, { readOnly: true });
		db.exec(`PRAGMA busy_timeout = ${HEALTH_CHECK_TIMEOUT_MS}`);
		const rows = db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>;
		const verdict = rows.map((row) => String(Object.values(row)[0] ?? '')).join('; ');
		const version = (db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0;
		const ok = verdict === 'ok';
		return ok ? { ok, integrity: 'ok', schema_version: Number(version) } : { ok, integrity: verdict.slice(0, 200), schema_version: Number(version) };
	} catch (e) {
		return { ok: false, error: errorCode(e) };
	} finally {
		try {
			db?.close();
		} catch {
			/* already closed */
		}
	}
}

/**
 * Takes the write lock and rolls back. Proves the write path is usable without a lasting change:
 * no row is inserted and no revision is recorded.
 */
export function checkWrite(file: string): WriteCheck {
	if (!fs.existsSync(file)) return { ok: false, mode: 'begin_immediate_rollback', error: 'database_missing' };
	let db: DatabaseSync | undefined;
	try {
		db = new DatabaseSync(file);
		db.exec(`PRAGMA busy_timeout = ${HEALTH_CHECK_TIMEOUT_MS}`);
		db.exec('BEGIN IMMEDIATE');
		db.exec('ROLLBACK');
		return { ok: true, mode: 'begin_immediate_rollback' };
	} catch (e) {
		try {
			db?.exec('ROLLBACK');
		} catch {
			/* no transaction open */
		}
		return { ok: false, mode: 'begin_immediate_rollback', error: errorCode(e) };
	} finally {
		try {
			db?.close();
		} catch {
			/* already closed */
		}
	}
}

/** Reports the deployed commit. A missing file is expected before the first deploy and not a failure. */
export function checkDeployed(file: string, now: Date): DeployedCheck {
	try {
		const stat = fs.statSync(file);
		const sha = fs.readFileSync(file, 'utf8').trim().slice(0, 64);
		if (!sha) return { ok: true, present: false };
		return { ok: true, present: true, sha, age_seconds: ageSeconds(stat.mtimeMs, now) };
	} catch {
		return { ok: true, present: false };
	}
}

/** Parses `backup ok <YYYY-MM-DD_HHMM>`; the stamp is local time of the server. */
export function lastBackupAt(log: string): { at: Date; raw: string } | null {
	let text: string;
	try {
		text = fs.readFileSync(log, 'utf8');
	} catch {
		return null;
	}
	const lines = text.split('\n');
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const m = /^backup ok (\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})/.exec(lines[i].trim());
		if (!m) continue;
		const [, year, month, day, hour, minute] = m;
		const at = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
		if (!Number.isNaN(at.getTime())) return { at, raw: m[0] };
	}
	return null;
}

export function checkBackup(log: string, now: Date, maxAgeSeconds = DEFAULT_MAX_BACKUP_AGE_SECONDS): BackupCheck {
	const last = lastBackupAt(log);
	if (!last) return { ok: false, max_age_seconds: maxAgeSeconds, error: 'no_backup_record' };
	const age = Math.round((now.getTime() - last.at.getTime()) / 1000);
	return {
		ok: age <= maxAgeSeconds,
		last_at: last.at.toISOString(),
		age_seconds: Math.max(0, age),
		max_age_seconds: maxAgeSeconds
	};
}

export function runHealthChecks(opts: HealthOptions = {}): { status: number; body: HealthReport } {
	const now = opts.now ?? new Date();
	const dbFile = opts.collectionsDb ?? collectionsFile('', process.env);
	const maxBackupAge = configuredMaxBackupAgeSeconds(opts);
	const database = checkDatabase(dbFile);
	const write = checkWrite(dbFile);
	const deployed = checkDeployed(shaFile(opts), now);
	const backup = checkBackup(backupLogFile(opts), now, maxBackupAge);
	const ok = database.ok && write.ok && backup.ok;
	return {
		status: ok ? 200 : 503,
		body: {
			status: ok ? 'ok' : 'fail',
			checked_at: now.toISOString(),
			checks: { database, write, deployed, backup }
		}
	};
}
