import { getFolio } from '#lib/server/service';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	const folio = await getFolio();
	const q = (url.searchParams.get('q') ?? '').slice(0, 200);
	return { q, results: q.trim() ? folio.search(q, 50) : [] };
};
