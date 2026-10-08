import { json } from '@sveltejs/kit';
import { MdwikiError } from '#lib/server/errors';
import { fail, readJson } from '#lib/server/http';
import { getMdwiki } from '#lib/server/service';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	try {
		return json(await (await getMdwiki()).readPage(params.path));
	} catch (e) {
		return fail(e);
	}
};

/** Create or overwrite. Body: { content, base_hash? } ("" = must not exist). */
export const PUT: RequestHandler = async ({ params, request }) => {
	try {
		const mdwiki = await getMdwiki();
		const body = await readJson(request, mdwiki.config.maxWriteBytes + 4096);
		const base = body.base_hash;
		if (base !== undefined && base !== null && typeof base !== 'string') {
			throw new MdwikiError(400, 'bad_base_hash', '"base_hash" must be a string');
		}
		return json(await mdwiki.writePage(params.path, body.content, base as string | undefined));
	} catch (e) {
		return fail(e);
	}
};

/** Append. Body: { content }. */
export const POST: RequestHandler = async ({ params, request }) => {
	try {
		const mdwiki = await getMdwiki();
		const body = await readJson(request, mdwiki.config.maxWriteBytes + 4096);
		return json(await mdwiki.appendToPage(params.path, body.content));
	} catch (e) {
		return fail(e);
	}
};

export const DELETE: RequestHandler = async ({ params }) => {
	try {
		return json(await (await getMdwiki()).deletePage(params.path));
	} catch (e) {
		return fail(e);
	}
};
