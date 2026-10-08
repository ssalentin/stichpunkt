import { json } from '@sveltejs/kit';
import { FolioError } from '#lib/server/errors';
import { fail, readJson } from '#lib/server/http';
import { getFolio } from '#lib/server/service';
import type { RequestHandler } from './$types';

/** Save from the editor. Body: { path, content, base_hash } ("" = new page). */
export const PUT: RequestHandler = async ({ request }) => {
	try {
		const folio = await getFolio();
		const b = await readJson(request, folio.config.maxWriteBytes + 4096);
		if (typeof b.path !== 'string') throw new FolioError(400, 'bad_path', '"path" required');
		const base = typeof b.base_hash === 'string' ? b.base_hash : undefined;
		return json(await folio.writePage(b.path, b.content, base));
	} catch (e) {
		return fail(e);
	}
};

export const DELETE: RequestHandler = async ({ request }) => {
	try {
		const folio = await getFolio();
		const b = await readJson(request, 4096);
		if (typeof b.path !== 'string') throw new FolioError(400, 'bad_path', '"path" required');
		return json(await folio.deletePage(b.path));
	} catch (e) {
		return fail(e);
	}
};
