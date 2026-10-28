import { json } from '@sveltejs/kit';
import { fail } from '#lib/server/http';
import { getMdwiki } from '#lib/server/service';
import type { RequestHandler } from './$types';

/** Read-only link audit. Query: ?path=&include_working=. */
export const GET: RequestHandler = async ({ url }) => {
	try {
		const mdwiki = await getMdwiki();
		const includeWorking = ['1', 'true', 'yes'].includes((url.searchParams.get('include_working') ?? '').toLowerCase());
		return json(await mdwiki.checkLinks(url.searchParams.get('path') ?? undefined, includeWorking));
	} catch (e) {
		return fail(e);
	}
};
