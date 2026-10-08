import { json } from '@sveltejs/kit';
import { FolioError } from '#lib/server/errors';
import { fail, readJson } from '#lib/server/http';
import { getFolio } from '#lib/server/service';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	try {
		return json(await (await getFolio()).readPage(params.path));
	} catch (e) {
		return fail(e);
	}
};

/** Create or overwrite. Body: { content, base_hash? } ("" = must not exist). */
export const PUT: RequestHandler = async ({ params, request }) => {
	try {
		const folio = await getFolio();
		const body = await readJson(request, folio.config.maxWriteBytes + 4096);
		const base = body.base_hash;
		if (base !== undefined && base !== null && typeof base !== 'string') {
			throw new FolioError(400, 'bad_base_hash', '"base_hash" must be a string');
		}
		return json(await folio.writePage(params.path, body.content, base as string | undefined));
	} catch (e) {
		return fail(e);
	}
};

/** Append. Body: { content }. */
export const POST: RequestHandler = async ({ params, request }) => {
	try {
		const folio = await getFolio();
		const body = await readJson(request, folio.config.maxWriteBytes + 4096);
		return json(await folio.appendToPage(params.path, body.content));
	} catch (e) {
		return fail(e);
	}
};

export const DELETE: RequestHandler = async ({ params }) => {
	try {
		return json(await (await getFolio()).deletePage(params.path));
	} catch (e) {
		return fail(e);
	}
};
