import { getMdwiki } from '#lib/server/service';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	const mdwiki = await getMdwiki();
	const q = (url.searchParams.get('q') ?? '').slice(0, 200);
	return { q, results: q.trim() ? mdwiki.search(q, 50) : [] };
};
