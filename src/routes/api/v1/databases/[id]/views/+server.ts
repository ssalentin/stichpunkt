import { json } from '@sveltejs/kit';
import { getCollections } from '#lib/server/collection-service';
import { fail, readJson } from '#lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	try {
		return json({ views: getCollections().views(params.id) });
	} catch (e) {
		return fail(e);
	}
};

/** Create or update a saved view. Body: { id?, name, filters?, sorts?, columns? } */
export const POST: RequestHandler = async ({ params, request }) => {
	try {
		const body = await readJson(request, 32 * 1024);
		return json(
			getCollections().saveView(params.id, {
				id: body.id,
				name: body.name,
				filters: body.filters,
				sorts: body.sorts,
				columns: body.columns
			}),
			{ status: 201 }
		);
	} catch (e) {
		return fail(e);
	}
};
