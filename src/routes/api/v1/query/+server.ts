import { json } from '@sveltejs/kit';
import { fail, readJson } from '#lib/server/http';
import { getMdwiki } from '#lib/server/service';
import type { RequestHandler } from './$types';

/**
 * Runs the declarative page query. The body is the same schema as the `pages` block and the
 * `query_pages` MCP tool, so an agent can test a query before writing it into a page.
 */
export const POST: RequestHandler = async ({ request }) => {
	try {
		const mdwiki = await getMdwiki();
		const body = await readJson(request, 64 * 1024);
		// `self` (optional) resolves "this" in `folder` / `links-to`
		const self = typeof body.self === 'string' ? body.self : '';
		const query = { ...body };
		delete query.self;
		return json(mdwiki.queryPages(query, self));
	} catch (e) {
		return fail(e);
	}
};
