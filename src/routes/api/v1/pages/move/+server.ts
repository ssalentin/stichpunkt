import { json } from '@sveltejs/kit';
import { MdwikiError } from '#lib/server/errors';
import { fail, readJson } from '#lib/server/http';
import { getMdwiki } from '#lib/server/service';
import type { RequestHandler } from './$types';

/** Move or rename a page. Body: { from, to, dry_run? }. */
export const POST: RequestHandler = async ({ request }) => {
	try {
		const mdwiki = await getMdwiki();
		const body = await readJson(request, 64 * 1024);
		if (typeof body.from !== 'string' || typeof body.to !== 'string') {
			throw new MdwikiError(400, 'bad_path', '"from" and "to" must be strings');
		}
		if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') {
			throw new MdwikiError(400, 'bad_request', '"dry_run" must be a boolean');
		}
		return json(await mdwiki.movePage(body.from, body.to, body.dry_run ?? false));
	} catch (e) {
		return fail(e);
	}
};
