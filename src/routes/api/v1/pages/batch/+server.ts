import { json } from '@sveltejs/kit';
import { MdwikiError } from '#lib/server/errors';
import { agentOf, fail, readJson } from '#lib/server/http';
import { getMdwiki } from '#lib/server/service';
import type { RequestHandler } from './$types';

/** Write several pages as one transaction. Body: { pages: [{ path, content, base_hash? }], dry_run? }. */
export const POST: RequestHandler = async ({ request }) => {
	try {
		const mdwiki = await getMdwiki();
		const body = await readJson(request, mdwiki.config.maxWriteBytes * 16 + 64 * 1024);
		if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') {
			throw new MdwikiError(400, 'bad_request', '"dry_run" must be a boolean');
		}
		return json(await mdwiki.writePages(body.pages, body.dry_run ?? false, agentOf(request)));
	} catch (e) {
		return fail(e);
	}
};
