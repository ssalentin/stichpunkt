import { json } from '@sveltejs/kit';
import { FolioError } from '#lib/server/errors';
import { fail } from '#lib/server/http';
import { getFolio } from '#lib/server/service';
import type { RequestHandler } from './$types';

/** Multipart upload from the editor: fields "page" and "file". */
export const POST: RequestHandler = async ({ request }) => {
	try {
		const folio = await getFolio();
		if (Number(request.headers.get('content-length') ?? 0) > folio.config.maxUploadBytes + 8192) {
			throw new FolioError(413, 'too_large', 'File too large');
		}
		const form = await request.formData();
		const page = form.get('page');
		const file = form.get('file');
		if (typeof page !== 'string' || !(file instanceof File)) {
			throw new FolioError(400, 'bad_request', '"page" and "file" required');
		}
		return json(await folio.uploadForPage(page, file.name, Buffer.from(await file.arrayBuffer())));
	} catch (e) {
		return fail(e);
	}
};
