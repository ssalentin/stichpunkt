import { json } from '@sveltejs/kit';
import { fail } from '#lib/server/http';
import { getMdwiki } from '#lib/server/service';
import type { RequestHandler } from './$types';

/** Read-only validation of the manifest: {ok, issues: [{path, message}]}. */
export const GET: RequestHandler = async () => {
	try {
		return json(await (await getMdwiki()).checkManifest());
	} catch (e) {
		return fail(e);
	}
};
