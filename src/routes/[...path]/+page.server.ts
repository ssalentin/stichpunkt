import { error } from '@sveltejs/kit';
import { MdwikiError } from '#lib/server/errors';
import { normalizeRel } from '#lib/server/paths';
import { getMdwiki } from '#lib/server/service';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const mdwiki = await getMdwiki();
	let name: string;
	try {
		name = normalizeRel(params.path.replace(/\/+$/, '').replace(/\.md$/i, ''));
	} catch (e) {
		error(400, e instanceof MdwikiError ? e.message : 'Invalid page name');
	}
	const view = await mdwiki.renderPage(name);
	if (!view) {
		return { kind: 'missing' as const, name, namespace: mdwiki.namespace(name), view: null };
	}
	return {
		kind: 'page' as const,
		name,
		namespace: [],
		view
	};
};
