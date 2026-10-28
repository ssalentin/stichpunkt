import { json } from '@sveltejs/kit';
import { fail } from '#lib/server/http';
import { getMdwiki } from '#lib/server/service';
import type { RequestHandler } from './$types';

/** Read-only link audit. Query: ?path=&include_hidden=. */
export const GET: RequestHandler = async ({ url }) => {
	try {
		const mdwiki = await getMdwiki();
		const includeHidden = ['1', 'true', 'yes'].includes((url.searchParams.get('include_hidden') ?? '').toLowerCase());
		return json(await mdwiki.checkLinks(url.searchParams.get('path') ?? undefined, includeHidden));
	} catch (e) {
		return fail(e);
	}
};
