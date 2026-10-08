import { json } from '@sveltejs/kit';
import { fail } from '#lib/server/http';
import { getMdwiki } from '#lib/server/service';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	try {
		const mdwiki = await getMdwiki();
		return json({ pages: mdwiki.listPages(url.searchParams.get('prefix') ?? '') });
	} catch (e) {
		return fail(e);
	}
};
