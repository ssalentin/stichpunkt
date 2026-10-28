import { json } from '@sveltejs/kit';
import { fail } from '#lib/server/http';
import { getMdwiki } from '#lib/server/service';
import type { RequestHandler } from './$types';

/** Revisions of a page, newest first. Query: ?limit=. Read only. */
export const GET: RequestHandler = async ({ params, url }) => {
	try {
		const mdwiki = await getMdwiki();
		const limit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
		return json(await mdwiki.history(params.path, Number.isFinite(limit) ? limit : 50));
	} catch (e) {
		return fail(e);
	}
};
