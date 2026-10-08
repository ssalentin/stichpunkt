import { json } from '@sveltejs/kit';
import { fail } from '#lib/server/http';
import { getFolio } from '#lib/server/service';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	try {
		const folio = await getFolio();
		return json({ results: folio.search(url.searchParams.get('q') ?? '', Number(url.searchParams.get('limit') ?? 30)) });
	} catch (e) {
		return fail(e);
	}
};
