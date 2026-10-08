import { getFolio } from '#lib/server/service';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const folio = await getFolio();
	const prefix = params.path.replace(/\/+$/, '');
	return { prefix, pages: folio.namespace(prefix), exists: !!folio.index.get(prefix) };
};
