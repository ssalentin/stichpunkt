import { json } from '@sveltejs/kit';
import { MdwikiError } from '#lib/server/errors';
import { fail, readJson } from '#lib/server/http';
import { getMdwiki } from '#lib/server/service';
import type { RequestHandler } from './$types';

/** Save from the editor. Body: { path, content, base_hash } ("" = new page). */
export const PUT: RequestHandler = async ({ request }) => {
	try {
		const mdwiki = await getMdwiki();
		const b = await readJson(request, mdwiki.config.maxWriteBytes + 4096);
		if (typeof b.path !== 'string') throw new MdwikiError(400, 'bad_path', '"path" required');
		const base = typeof b.base_hash === 'string' ? b.base_hash : undefined;
		return json(await mdwiki.writePage(b.path, b.content, base));
	} catch (e) {
		return fail(e);
	}
};

export const DELETE: RequestHandler = async ({ request }) => {
	try {
		const mdwiki = await getMdwiki();
		const b = await readJson(request, 4096);
		if (typeof b.path !== 'string') throw new MdwikiError(400, 'bad_path', '"path" required');
		return json(await mdwiki.deletePage(b.path));
	} catch (e) {
		return fail(e);
	}
};
