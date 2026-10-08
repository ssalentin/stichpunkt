import { error } from '@sveltejs/kit';
import { FolioError } from '#lib/server/errors';
import { normalizeRel } from '#lib/server/paths';
import { getFolio } from '#lib/server/service';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, url }) => {
	const folio = await getFolio();
	let name: string;
	try {
		name = normalizeRel(params.path.replace(/\/+$/, '').replace(/\.md$/i, ''));
	} catch (e) {
		error(400, e instanceof FolioError ? e.message : 'Invalid page name');
	}
	const edit = url.searchParams.has('edit');
	const view = await folio.renderPage(name);
	if (!view) {
		return { kind: 'missing' as const, name, edit, namespace: folio.namespace(name), view: null, raw: null };
	}
	const raw = edit ? await folio.readPage(name) : null;
	return {
		kind: 'page' as const,
		name,
		edit,
		namespace: [],
		view,
		raw: raw ? { content: raw.content, hash: raw.hash } : null
	};
};
