import { getMdwiki } from '#lib/server/service';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ depends }) => {
	depends('app:space');
	const mdwiki = await getMdwiki();
	return { tree: mdwiki.tree(), recent: mdwiki.recent(8), tags: mdwiki.listTags().slice(0, 40) };
};
