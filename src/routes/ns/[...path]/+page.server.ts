import { getMdwiki } from '#lib/server/service';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const mdwiki = await getMdwiki();
	const prefix = params.path.replace(/\/+$/, '');
	return { prefix, pages: mdwiki.namespace(prefix), exists: !!mdwiki.index.get(prefix) };
};
