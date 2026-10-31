import { json } from '@sveltejs/kit';
import { getCollections } from '#lib/server/collection-service';
import { fail } from '#lib/server/http';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = async ({ params }) => {
	try {
		getCollections().deleteView(params.id, params.viewId);
		return json({ id: params.viewId, deleted: true });
	} catch (e) {
		return fail(e);
	}
};
