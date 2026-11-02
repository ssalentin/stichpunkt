/**
 * Merges page revisions and collection row revisions into one chronological feed.
 * Pure functions: the route maps service records to `FeedEntry`, this module filters,
 * orders and groups them, so the presentation rules stay testable without a server.
 */

export type ActorSource = 'token' | 'field' | 'human' | 'unknown' | 'system';

export interface FeedEntry {
	/** stable key, unique across sources */
	id: string;
	/** ISO timestamp */
	at: string;
	/** slug the writer reported */
	actor: string;
	/** display name from the manifest, falling back to the slug */
	actorName: string;
	/** how the actor was established: token = verified, field = self-declared */
	actorSource: ActorSource;
	kind: 'page' | 'row';
	/** tool or row operation, e.g. write_page, move_page, create, update, delete */
	action: string;
	/** page path or collection name */
	target: string;
	href: string;
	/** optional note, or the row title so a row change is recognisable */
	detail?: string;
}

export interface ActivityFilter {
	/** actor slug, matched case-insensitively */
	actor?: string;
	/** ISO date or timestamp; entries before it are dropped */
	since?: string;
	limit?: number;
}

export function actorSourceOf(actor: string, reported?: string): ActorSource {
	if (reported === 'token' || reported === 'field' || reported === 'human' || reported === 'unknown') return reported;
	if (actor === 'web-ui') return 'human';
	if (actor === 'deploy-gate' || actor === 'migration' || actor === 'api') return 'system';
	return 'unknown';
}

/** Filters, drops duplicates, newest first. Invalid `since` values are ignored. */
export function selectActivity(entries: FeedEntry[], filter: ActivityFilter = {}): FeedEntry[] {
	const actor = filter.actor?.trim().toLowerCase() ?? '';
	const cutoff = filter.since ? Date.parse(filter.since) : Number.NaN;
	const since = Number.isNaN(cutoff) ? null : cutoff;
	const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 100), 1), 500);
	const seen = new Set<string>();
	const out: FeedEntry[] = [];
	for (const entry of entries) {
		if (actor && entry.actor.toLowerCase() !== actor) continue;
		if (since !== null) {
			const at = Date.parse(entry.at);
			if (Number.isNaN(at) || at < since) continue;
		}
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		out.push(entry);
	}
	out.sort((a, b) => {
		const diff = Date.parse(b.at) - Date.parse(a.at);
		return diff !== 0 ? diff : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
	});
	return out.slice(0, limit);
}

export interface DayGroup {
	/** YYYY-MM-DD in the requested zone */
	day: string;
	entries: FeedEntry[];
}

/** Groups consecutive entries by calendar day; the input must already be sorted newest first. */
export function groupByDay(entries: FeedEntry[], timeZone = 'Europe/Berlin'): DayGroup[] {
	const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
	const groups: DayGroup[] = [];
	for (const entry of entries) {
		const at = new Date(entry.at);
		const day = Number.isNaN(at.getTime()) ? 'unknown' : format.format(at);
		const last = groups.at(-1);
		if (last && last.day === day) last.entries.push(entry);
		else groups.push({ day, entries: [entry] });
	}
	return groups;
}

/** Trims a revision note for the feed; empty notes are dropped. */
export function shortNote(note: unknown, max = 160): string | undefined {
	if (typeof note !== 'string') return undefined;
	const text = note.replace(/\s+/g, ' ').trim();
	if (!text) return undefined;
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
