import { json } from '@sveltejs/kit';
import { fail } from '#lib/server/http';
import { getFolio } from '#lib/server/service';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	try {
		return json({ tags: (await getFolio()).listTags() });
	} catch (e) {
		return fail(e);
	}
};
