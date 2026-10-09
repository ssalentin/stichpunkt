import { getMdwiki } from '#lib/server/service';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	const mdwiki = await getMdwiki();
	const q = (url.searchParams.get('q') ?? '').slice(0, 200);
	if (!q.trim()) {
		// empty state: guide the eye with the most recently changed pages
		return { q, result: null, recent: mdwiki.recent(12) };
	}
	return { q, result: mdwiki.search(q, 50), recent: [] };
};
