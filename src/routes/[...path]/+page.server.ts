import { error } from '@sveltejs/kit';
import { MdwikiError } from '#lib/server/errors';
import { normalizeRel } from '#lib/server/paths';
import { getMdwiki } from '#lib/server/service';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, url }) => {
	const mdwiki = await getMdwiki();
	let name: string;
	try {
		name = normalizeRel(params.path.replace(/\/+$/, '').replace(/\.md$/i, ''));
	} catch (e) {
		error(400, e instanceof MdwikiError ? e.message : 'Invalid page name');
	}
	const edit = url.searchParams.has('edit');
	const view = await mdwiki.renderPage(name);
	if (!view) {
		return { kind: 'missing' as const, name, edit, namespace: mdwiki.namespace(name), view: null, raw: null };
	}
	const raw = edit ? await mdwiki.readPage(name) : null;
	return {
		kind: 'page' as const,
		name,
		edit,
		namespace: [],
		view,
		raw: raw ? { content: raw.content, hash: raw.hash } : null
	};
};
