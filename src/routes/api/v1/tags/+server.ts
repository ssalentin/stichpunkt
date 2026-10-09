import { json } from '@sveltejs/kit';
import { fail } from '#lib/server/http';
import { getMdwiki } from '#lib/server/service';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	try {
		return json({ tags: (await getMdwiki()).listTags() });
	} catch (e) {
		return fail(e);
	}
};
