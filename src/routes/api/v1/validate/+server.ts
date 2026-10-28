import { json } from '@sveltejs/kit';
import { agentOf, fail, readJson } from '#lib/server/http';
import { getMdwiki } from '#lib/server/service';
import type { RequestHandler } from './$types';

/** Dry run of the manifest page checks. Body: { path, content }. Writes nothing. */
export const POST: RequestHandler = async ({ request }) => {
	try {
		const mdwiki = await getMdwiki();
		const body = await readJson(request, mdwiki.config.maxWriteBytes + 4096);
		return json(mdwiki.validatePage(body.path, body.content, agentOf(request)));
	} catch (e) {
		return fail(e);
	}
};
