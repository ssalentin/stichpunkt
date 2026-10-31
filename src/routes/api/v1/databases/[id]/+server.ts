import { json } from '@sveltejs/kit';
import { getCollections } from '#lib/server/collection-service';
import { fail, readJson } from '#lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	try {
		const store = getCollections();
		return json({ ...store.get(params.id), views: store.views(params.id) });
	} catch (e) {
		return fail(e);
	}
};

/** Rename or change the icon. Body: { name?, icon? } */
export const PATCH: RequestHandler = async ({ params, request }) => {
	try {
		const body = await readJson(request, 16 * 1024);
		return json(getCollections().rename(params.id, { name: body.name, icon: body.icon }));
	} catch (e) {
		return fail(e);
	}
};

export const DELETE: RequestHandler = async ({ params }) => {
	try {
		getCollections().delete(params.id);
		return json({ id: params.id, deleted: true });
	} catch (e) {
		return fail(e);
	}
};
