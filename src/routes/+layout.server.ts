import { getFolio } from '#lib/server/service';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ depends }) => {
	depends('app:space');
	const folio = await getFolio();
	return { tree: folio.tree(), recent: folio.recent(8), tags: folio.listTags().slice(0, 40) };
};
