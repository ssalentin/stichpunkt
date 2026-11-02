import { getMdwiki } from '#lib/server/service';
import { getCollections } from '#lib/server/collection-service';
import { actorSourceOf, selectActivity, shortNote, type FeedEntry } from '#lib/activity-feed';
import type { PageServerLoad } from './$types';

const MAX_LIMIT = 300;

/** Page revisions and collection row revisions in one list, newest first. Read only. */
export const load: PageServerLoad = async ({ url }) => {
	const requested = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
	const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), MAX_LIMIT) : 150;
	const actor = url.searchParams.get('actor')?.trim() ?? '';
	const since = url.searchParams.get('since')?.trim() ?? '';

	const mdwiki = await getMdwiki();
	const pages = await mdwiki.activity(since || undefined, actor || undefined, undefined, undefined, limit);

	const entries: FeedEntry[] = pages.records.map((record) => ({
		id: `page:${record.path}:${record.id}`,
		at: record.at,
		actor: record.actor,
		actorName: record.actor_name ?? record.actor,
		actorSource: actorSourceOf(record.actor, record.actor_source),
		kind: 'page',
		action: record.tool,
		target: record.path,
		href: `/${record.path.split('/').map(encodeURIComponent).join('/')}`,
		detail: shortNote(record.note)
	}));

	const store = getCollections();
	for (const collection of store.list()) {
		const title = collection.properties.find((property) => property.type === 'title') ?? collection.properties[0];
		for (const revision of store.history(collection.id, undefined, limit)) {
			const values = (revision.after ?? revision.before) as Record<string, unknown> | null;
			const label = title && values ? String(values[title.name] ?? '').trim() : '';
			const actorSlug = String(revision.actor ?? 'unknown');
			entries.push({
				id: `row:${collection.id}:${revision.id}`,
				at: String(revision.at),
				actor: actorSlug,
				actorName: actorSlug,
				actorSource: actorSourceOf(actorSlug),
				kind: 'row',
				action: String(revision.op),
				target: collection.name,
				href: `/databases/${collection.id}`,
				detail: label || undefined
			});
		}
	}

	return {
		items: selectActivity(entries, { actor, since, limit }),
		actor,
		since,
		limit
	};
};
