import { json } from '@sveltejs/kit';
import { fail, readBytes } from '#lib/server/http';
import { getMdwiki } from '#lib/server/service';
import type { RequestHandler } from './$types';

/** Raw body upload of any allowed file type. */
export const PUT: RequestHandler = async ({ params, request }) => {
	try {
		const mdwiki = await getMdwiki();
		const bytes = await readBytes(request, mdwiki.config.maxUploadBytes);
		return json(await mdwiki.uploadAttachment(params.path, bytes));
	} catch (e) {
		return fail(e);
	}
};
