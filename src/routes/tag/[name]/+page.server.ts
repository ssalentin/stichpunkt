import { getFolio } from '#lib/server/service';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const folio = await getFolio();
	const tag = params.name.toLowerCase();
	return { tag, pages: folio.pagesByTag(tag), tagPage: folio.index.tagPageFor(tag) ?? null };
};
