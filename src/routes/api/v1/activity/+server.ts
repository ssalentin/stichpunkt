import { json } from '@sveltejs/kit';
import { fail } from '#lib/server/http';
import { getMdwiki } from '#lib/server/service';
import type { RequestHandler } from './$types';

/** Revision activity across pages. Query: ?since=&actor=&folder=&page=&limit=. Read only. */
export const GET: RequestHandler = async ({ url }) => {
	try {
		const mdwiki = await getMdwiki();
		const limit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
		return json(
			await mdwiki.activity(
				url.searchParams.get('since') ?? undefined,
				url.searchParams.get('actor') ?? undefined,
				url.searchParams.get('folder') ?? undefined,
				url.searchParams.get('page') ?? undefined,
				Number.isFinite(limit) ? limit : 50
			)
		);
	} catch (e) {
		return fail(e);
	}
};
