import { json } from '@sveltejs/kit';
import { fail } from '#lib/server/http';
import { getFolio } from '#lib/server/service';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	try {
		return json({ path: params.path, backlinks: (await getFolio()).getBacklinks(params.path) });
	} catch (e) {
		return fail(e);
	}
};
