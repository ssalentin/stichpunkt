import { getMdwiki } from '#lib/server/service';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const mdwiki = await getMdwiki();
	const pages = mdwiki.listPages();
	return {
		recent: mdwiki.recent(6),
		tags: mdwiki.listTags().slice(0, 12),
		pageCount: pages.length
	};
};
