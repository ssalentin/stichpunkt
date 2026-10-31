import { json } from '@sveltejs/kit';
import { getCollections } from '#lib/server/collection-service';
import { agentOf, fail, readJson } from '#lib/server/http';
import type { RequestHandler } from './$types';

/** Read rows. Query params: view, limit, offset and repeated filter=property:op:value / sort=property:asc. */
export const GET: RequestHandler = async ({ params, url }) => {
	try {
		const filters = url.searchParams.getAll('filter').map(parseFilter);
		const sorts = url.searchParams.getAll('sort').map(parseSort);
		const limit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
		const offset = Number.parseInt(url.searchParams.get('offset') ?? '', 10);
		return json(
			getCollections().query(params.id, {
				filters,
				sorts,
				limit: Number.isFinite(limit) ? limit : undefined,
				offset: Number.isFinite(offset) ? offset : undefined,
				view: url.searchParams.get('view') ?? undefined
			})
		);
	} catch (e) {
		return fail(e);
	}
};

/** Create a row. Body: { values: {...}, actor? } */
export const POST: RequestHandler = async ({ params, request }) => {
	try {
		const body = await readJson(request, 256 * 1024);
		const actor = typeof body.actor === 'string' ? body.actor : (agentOf(request) ?? 'api');
		return json(getCollections().createRow(params.id, body.values, actor), { status: 201 });
	} catch (e) {
		return fail(e);
	}
};

function parseFilter(raw: string) {
	const [property, op, ...rest] = raw.split(':');
	return { property, op: op as never, value: rest.length ? rest.join(':') : undefined };
}

function parseSort(raw: string) {
	const [property, direction] = raw.split(':');
	return { property, direction: direction === 'desc' ? ('desc' as const) : ('asc' as const) };
}
