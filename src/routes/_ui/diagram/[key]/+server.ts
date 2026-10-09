import { error } from '@sveltejs/kit';
import { getMdwiki } from '#lib/server/service';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	const svg = await (await getMdwiki()).kroki.cached(params.key);
	if (!svg) error(404, 'Diagram not in cache');
	return new Response(svg, {
		headers: {
			'content-type': 'image/svg+xml',
			'cache-control': 'public, max-age=31536000, immutable',
			'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"
		}
	});
};
