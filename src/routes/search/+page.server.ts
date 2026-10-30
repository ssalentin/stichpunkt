import { getMdwiki } from '#lib/server/service';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	const mdwiki = await getMdwiki();
	const q = (url.searchParams.get('q') ?? '').slice(0, 200);
	const pages = mdwiki.listPages();
	// suggestions for the search page; capped so a large space keeps the payload small
	const jumpTitles = pages.slice(0, 400).map((p) => ({ path: p.path, title: p.title, layer: p.layer, mtimeMs: Date.parse(p.mtime) || 0 }));
	const tagNames = mdwiki
		.listTags()
		.slice(0, 24)
		.map((t) => t.name);
	if (!q.trim()) {
		// empty state: guide the eye with the most recently changed pages
		return { q, result: null, recent: mdwiki.recent(12), jumpTitles, tagNames };
	}
	// The client filters by the sidebar layer view without a roundtrip and shows 50.
	return { q, result: mdwiki.search(q, 200, true), recent: [], jumpTitles, tagNames };
};
