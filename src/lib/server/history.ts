/**
 * Revision store for page writes. Every write through the service keeps the previous content
 * under `.history/<page>/<timestamp>-<hash>.md` plus a `.json` sidecar with the full record:
 * version, time, actor, actor source, tool, byte statistics, warning rules and an optional note.
 * Direct file edits are not recorded: only the MCP and REST write paths call in here.
 */

import { hashOf, type Store } from './store';

export const HISTORY_DIR = '.history';

export type ActorSource = 'token' | 'field' | 'human' | 'unknown';
export type RevisionTool = 'write_page' | 'append_to_page' | 'move_page' | 'delete_page';

export interface Revision {
	id: string;
	/** short content hash of the stored revision */
	hash: string;
	/** per-page sequence number of this record, starting at 1 */
	version: number;
	at: string;
	/** stable slug, never an empty string */
	actor: string;
	actor_source: ActorSource;
	tool: RevisionTool;
	bytes_added: number;
	bytes_removed: number;
	warnings: string[];
	note?: string;
	marker?: string;
	size: number;
}

export interface RecordOptions {
	/** revisions kept per page; older ones are pruned. <= 0 keeps everything. */
	keep: number;
	actor: string;
	actorSource: ActorSource;
	tool: RevisionTool;
	bytesAdded: number;
	bytesRemoved: number;
	warnings: string[];
	note?: string;
	marker?: string;
}

interface Sidecar {
	version?: number;
	at?: string;
	actor?: string;
	actor_source?: ActorSource;
	tool?: RevisionTool;
	bytes_added?: number;
	bytes_removed?: number;
	warnings?: string[];
	note?: string;
	marker?: string;
}

export interface ActivityQuery {
	since?: Date;
	actor?: string;
	folder?: string;
	page?: string;
	limit: number;
}

/** Compact, lexicographically sortable stamp: 20261028T210012345Z. */
export function stamp(at: Date): string {
	return at.toISOString().replace(/[-:.]/g, '');
}

export function historyRel(path: string): string {
	return `${HISTORY_DIR}/${path}`;
}

export async function recordRevision(store: Store, path: string, data: Buffer, opts: RecordOptions): Promise<Revision> {
	const at = new Date();
	const hash = hashOf(data).slice(0, 12);
	const id = `${stamp(at)}-${hash}`;
	const base = `${historyRel(path)}/${id}`;
	const existing = await listRevisions(store, path);
	const version = existing.reduce((max, revision) => Math.max(max, revision.version), 0) + 1;
	const sidecar: Sidecar = {
		version,
		at: at.toISOString(),
		actor: opts.actor,
		actor_source: opts.actorSource,
		tool: opts.tool,
		bytes_added: opts.bytesAdded,
		bytes_removed: opts.bytesRemoved,
		warnings: opts.warnings,
		...(opts.note ? { note: opts.note } : {}),
		...(opts.marker ? { marker: opts.marker } : {})
	};
	await store.write(`${base}.md`, data, 'page');
	await store.write(`${base}.json`, Buffer.from(JSON.stringify(sidecar), 'utf8'), 'page');
	if (opts.keep > 0) await prune(store, path, opts.keep);
	return {
		id,
		hash,
		version,
		at: sidecar.at!,
		actor: opts.actor,
		actor_source: opts.actorSource,
		tool: opts.tool,
		bytes_added: opts.bytesAdded,
		bytes_removed: opts.bytesRemoved,
		warnings: opts.warnings,
		...(opts.note ? { note: opts.note } : {}),
		...(opts.marker ? { marker: opts.marker } : {}),
		size: data.length
	};
}

/** Newest first. */
export async function listRevisions(store: Store, path: string): Promise<Revision[]> {
	const entries = await store.list(historyRel(path));
	const ids = entries.filter((name) => name.endsWith('.md')).map((name) => name.slice(0, -3));
	const revisions: Revision[] = [];
	for (const id of ids) {
		const info = await store.stat(`${historyRel(path)}/${id}.md`);
		if (!info) continue;
		const meta = await readSidecar(store, path, id);
		revisions.push({
			id,
			hash: id.slice(id.lastIndexOf('-') + 1),
			version: meta.version ?? 0,
			at: meta.at ?? stampToIso(id.slice(0, id.lastIndexOf('-'))) ?? new Date(info.mtimeMs).toISOString(),
			actor: meta.actor ?? 'unknown',
			actor_source: meta.actor_source ?? 'unknown',
			tool: meta.tool ?? 'write_page',
			bytes_added: meta.bytes_added ?? 0,
			bytes_removed: meta.bytes_removed ?? 0,
			warnings: meta.warnings ?? [],
			...(meta.note ? { note: meta.note } : {}),
			...(meta.marker ? { marker: meta.marker } : {}),
			size: info.size
		});
	}
	revisions.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
	// sidecars from before the version field carry none; number the oldest as 1
	const missing = revisions.filter((revision) => revision.version === 0);
	if (missing.length) {
		const ordered = [...revisions].reverse();
		ordered.forEach((revision, index) => {
			if (revision.version === 0) revision.version = index + 1;
		});
	}
	return revisions;
}

export async function readRevision(store: Store, path: string, id: string): Promise<{ revision: Revision; content: string } | null> {
	const file = await store.read(`${historyRel(path)}/${id}.md`);
	if (!file) return null;
	const revisions = await listRevisions(store, path);
	const revision = revisions.find((r) => r.id === id);
	if (!revision) return null;
	return { revision, content: file.data.toString('utf8') };
}

/**
 * Moves the whole history of a page to its new path. Existing records at the destination keep
 * their numbers; the moved ones continue after them, so a page never restarts at version 1.
 */
export async function moveHistory(store: Store, from: string, to: string): Promise<void> {
	if (from === to) return;
	const source = await listRevisions(store, from);
	if (!source.length) return;
	const target = await listRevisions(store, to);
	const offset = target.reduce((max, revision) => Math.max(max, revision.version), 0);
	for (const revision of [...source].reverse()) {
		const meta = await readSidecar(store, from, revision.id);
		const file = await store.read(`${historyRel(from)}/${revision.id}.md`);
		if (file) {
			const next: Sidecar = { ...meta, version: revision.version + offset, at: meta.at ?? revision.at };
			await store.write(`${historyRel(to)}/${revision.id}.md`, file.data, 'page');
			await store.write(`${historyRel(to)}/${revision.id}.json`, Buffer.from(JSON.stringify(next), 'utf8'), 'page');
		}
		await store.remove(`${historyRel(from)}/${revision.id}.md`);
		await store.remove(`${historyRel(from)}/${revision.id}.json`);
	}
}

/** All revisions below `.history/`, newest first, with filters. */
export async function listActivity(store: Store, query: ActivityQuery): Promise<{ records: (Revision & { path: string })[]; total: number }> {
	const files = await store.listTree(HISTORY_DIR);
	const pages = new Set<string>();
	for (const file of files) {
		if (!file.endsWith('.md') || !file.startsWith(HISTORY_DIR + '/')) continue;
		const rel = file.slice(HISTORY_DIR.length + 1);
		const dir = rel.slice(0, rel.lastIndexOf('/'));
		if (dir) pages.add(dir);
	}
	const records: (Revision & { path: string })[] = [];
	for (const page of pages) {
		for (const revision of await listRevisions(store, page)) records.push({ ...revision, path: page });
	}
	const filtered = records
		.filter((record) => {
			if (query.page && record.path !== query.page) return false;
			if (query.folder && !(record.path === query.folder || record.path.startsWith(query.folder + '/'))) return false;
			if (query.actor && record.actor.toLowerCase() !== query.actor.toLowerCase()) return false;
			if (query.since && new Date(record.at).getTime() < query.since.getTime()) return false;
			return true;
		})
		.sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1));
	return { records: filtered.slice(0, query.limit), total: filtered.length };
}

async function readSidecar(store: Store, path: string, id: string): Promise<Sidecar> {
	const file = await store.read(`${historyRel(path)}/${id}.json`);
	if (!file) return {};
	try {
		const value = JSON.parse(file.data.toString('utf8')) as Sidecar;
		return value && typeof value === 'object' ? value : {};
	} catch {
		return {};
	}
}

function stampToIso(stampText: string): string | null {
	const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(stampText);
	if (!m) return null;
	const [, y, mo, d, h, mi, s, ms] = m;
	return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms))).toISOString();
}

async function prune(store: Store, path: string, keep: number): Promise<void> {
	const revisions = await listRevisions(store, path);
	for (const revision of revisions.slice(keep)) {
		await store.remove(`${historyRel(path)}/${revision.id}.md`);
		await store.remove(`${historyRel(path)}/${revision.id}.json`);
	}
}
