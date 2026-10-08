import { json } from '@sveltejs/kit';
import { fail } from '#lib/server/http';
import { getMdwiki } from '#lib/server/service';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	try {
		return json({ path: params.path, backlinks: (await getMdwiki()).getBacklinks(params.path) });
	} catch (e) {
		return fail(e);
	}
};
