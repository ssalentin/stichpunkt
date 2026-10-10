import { json } from '@sveltejs/kit';
import { fail, readJson } from '#lib/server/http';
import { getMdwiki } from '#lib/server/service';
import type { RequestHandler } from './$types';

/**
 * Evaluates one `${...}` expression against the index. The body is `{expr, page?}`; `page` sets
 * `this`. The response is `{value, text}` where `value` is the JSON projection and `text` the
 * rendered text form, so an agent can test an expression before writing it into a page. Read only.
 */
export const POST: RequestHandler = async ({ request }) => {
	try {
		const mdwiki = await getMdwiki();
		const body = await readJson(request, 64 * 1024);
		const page = typeof body.page === 'string' ? body.page : '';
		return json(mdwiki.evaluateExpression(body.expr, page));
	} catch (e) {
		return fail(e);
	}
};
