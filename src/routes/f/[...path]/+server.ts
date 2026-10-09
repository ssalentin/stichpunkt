import { error } from '@sveltejs/kit';
import { MdwikiError } from '#lib/server/errors';
import { assertAllowedExtension, extOf, normalizeRel } from '#lib/server/paths';
import { getMdwiki } from '#lib/server/service';
import type { RequestHandler } from './$types';

const TYPES: Record<string, string> = {
	png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
	avif: 'image/avif', heic: 'image/heic', svg: 'image/svg+xml', pdf: 'application/pdf',
	txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8',
	json: 'application/json'
};

/** Serves attachments from the space. Same path rules as every other access. */
export const GET: RequestHandler = async ({ params, request }) => {
	let rel: string;
	try {
		rel = normalizeRel(params.path);
		assertAllowedExtension(rel);
	} catch (e) {
		error(e instanceof MdwikiError ? e.status : 400, 'Bad path');
	}
	const mdwiki = await getMdwiki();
	let file;
	try {
		file = await mdwiki.store.read(rel);
	} catch {
		error(400, 'Bad path');
	}
	if (!file) error(404, 'Not found');
	const etag = `"${file.info.mtimeMs.toString(36)}-${file.info.size.toString(36)}"`;
	const headers: Record<string, string> = {
		'content-type': TYPES[extOf(rel)] ?? 'application/octet-stream',
		'cache-control': 'private, no-cache',
		etag,
		// uploaded SVG/PDF must never run script in our origin
		'content-security-policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'"
	};
	if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
	return new Response(new Uint8Array(file.data), { headers });
};
