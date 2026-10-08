import { getMdwiki } from '#lib/server/service';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const mdwiki = await getMdwiki();
	const tag = params.name.toLowerCase();
	return { tag, pages: mdwiki.pagesByTag(tag), tagPage: mdwiki.index.tagPageFor(tag) ?? null };
};
