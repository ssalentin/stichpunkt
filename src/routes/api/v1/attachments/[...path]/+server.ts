import { json } from '@sveltejs/kit';
import { fail, readBytes } from '#lib/server/http';
import { getFolio } from '#lib/server/service';
import type { RequestHandler } from './$types';

/** Raw body upload of any allowed file type. */
export const PUT: RequestHandler = async ({ params, request }) => {
	try {
		const folio = await getFolio();
		const bytes = await readBytes(request, folio.config.maxUploadBytes);
		return json(await folio.uploadAttachment(params.path, bytes));
	} catch (e) {
		return fail(e);
	}
};
