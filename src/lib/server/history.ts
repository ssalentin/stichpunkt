/**
 * Revision store for page writes. Every write through the service keeps the previous content
 * under `.history/<page>/<timestamp>-<hash>.md` plus a small `.json` sidecar with the time,
 * the marker (deleted / moved to X) and the acting agent. Direct file edits are not recorded:
 * only the MCP and REST write paths call in here.
 */

import { hashOf, type Store } from './store';

export const HISTORY_DIR = '.history';

export interface Revision {
	id: string;
	/** short content hash of the stored revision */
	hash: string;
	at: string;
	size: number;
	marker?: string;
	agent?: string;
}

export interface RecordOptions {
	/** revisions kept per page; older ones are pruned. <= 0 keeps everything. */
	keep: number;
	marker?: string;
	agent?: string;
}

interface Sidecar {
	at?: string;
	marker?: string;
	agent?: string;
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
	await store.write(`${base}.md`, data, 'page');
	const sidecar: Sidecar = { at: at.toISOString(), ...(opts.marker ? { marker: opts.marker } : {}), ...(opts.agent ? { agent: opts.agent } : {}) };
	await store.write(`${base}.json`, Buffer.from(JSON.stringify(sidecar), 'utf8'), 'page');
	if (opts.keep > 0) await prune(store, path, opts.keep);
	return { id, hash, at: at.toISOString(), size: data.length, ...(opts.marker ? { marker: opts.marker } : {}), ...(opts.agent ? { agent: opts.agent } : {}) };
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
			at: meta.at ?? stampToIso(id.slice(0, id.lastIndexOf('-'))) ?? new Date(info.mtimeMs).toISOString(),
			size: info.size,
			...(meta.marker ? { marker: meta.marker } : {}),
			...(meta.agent ? { agent: meta.agent } : {})
		});
	}
	return revisions.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

export async function readRevision(store: Store, path: string, id: string): Promise<{ revision: Revision; content: string } | null> {
	const file = await store.read(`${historyRel(path)}/${id}.md`);
	if (!file) return null;
	const revisions = await listRevisions(store, path);
	const revision = revisions.find((r) => r.id === id);
	if (!revision) return null;
	return { revision, content: file.data.toString('utf8') };
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
