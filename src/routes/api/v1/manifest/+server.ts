import { json } from '@sveltejs/kit';
import { fail } from '#lib/server/http';
import { getMdwiki } from '#lib/server/service';
import type { RequestHandler } from './$types';

/** The agent manifest: `{exists, path, hash, rules, prose}` or `{exists: false}`. */
export const GET: RequestHandler = async () => {
	try {
		return json((await getMdwiki()).getManifest());
	} catch (e) {
		return fail(e);
	}
};
