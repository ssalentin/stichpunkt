import { json } from '@sveltejs/kit';
import { MdwikiError } from '#lib/server/errors';
import { fail, readJson } from '#lib/server/http';
import { getMdwiki } from '#lib/server/service';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const mdwiki = await getMdwiki();
		const b = await readJson(request, 4096);
		if (typeof b.path !== 'string' || typeof b.line !== 'number' || typeof b.base_hash !== 'string') {
			throw new MdwikiError(400, 'bad_request', 'path, line and base_hash required');
		}
		return json(await mdwiki.toggleTask(b.path, b.line, b.base_hash));
	} catch (e) {
		return fail(e);
	}
};
