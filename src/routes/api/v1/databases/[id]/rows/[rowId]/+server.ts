import { json } from '@sveltejs/kit';
import { getCollections } from '#lib/server/collection-service';
import { agentOf, fail, readJson } from '#lib/server/http';
import type { RequestHandler } from './$types';

/** Update a row. Body: { values: {...}, actor?, base_updated_at? } */
export const PATCH: RequestHandler = async ({ params, request }) => {
	try {
		const body = await readJson(request, 256 * 1024);
		const actor = typeof body.actor === 'string' ? body.actor : (agentOf(request) ?? 'api');
		const base = typeof body.base_updated_at === 'string' ? body.base_updated_at : undefined;
		return json(getCollections().updateRow(params.id, params.rowId, body.values, actor, base));
	} catch (e) {
		return fail(e);
	}
};

export const DELETE: RequestHandler = async ({ params, request }) => {
	try {
		getCollections().deleteRow(params.id, params.rowId, agentOf(request) ?? 'api');
		return json({ id: params.rowId, deleted: true });
	} catch (e) {
		return fail(e);
	}
};
