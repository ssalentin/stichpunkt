import { json } from '@sveltejs/kit';
import { fail } from '#lib/server/http';
import { getMdwiki } from '#lib/server/service';
import type { RequestHandler } from './$types';

/** Unified diff of a page against a revision (revision id, hash prefix, or ISO time). Query: ?since=. */
export const GET: RequestHandler = async ({ params, url }) => {
	try {
		const mdwiki = await getMdwiki();
		return json(await mdwiki.diff(params.path, url.searchParams.get('since') ?? undefined));
	} catch (e) {
		return fail(e);
	}
};
