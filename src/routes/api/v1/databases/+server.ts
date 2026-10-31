import { json } from '@sveltejs/kit';
import { getCollections } from '#lib/server/collection-service';
import { fail, readJson } from '#lib/server/http';
import type { RequestHandler } from './$types';

/** List all collections with row and view counts. */
export const GET: RequestHandler = async () => {
	try {
		return json({ databases: getCollections().list() });
	} catch (e) {
		return fail(e);
	}
};

/** Create a collection. Body: { name, icon?, properties: [{name, type, options?}] } */
export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await readJson(request, 64 * 1024);
		return json(getCollections().create({ name: body.name, icon: body.icon, properties: body.properties }), { status: 201 });
	} catch (e) {
		return fail(e);
	}
};
