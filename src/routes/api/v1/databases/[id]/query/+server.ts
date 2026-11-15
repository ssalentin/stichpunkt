import { json } from '@sveltejs/kit';
import { getCollections } from '#lib/server/collection-service';
import { fail, readJson } from '#lib/server/http';
import type { Aggregates, GroupBy } from '#lib/server/collections';
import type { RequestHandler } from './$types';

/** Query rows with a JSON body: { filters?, sorts?, limit?, offset?, view?, group_by?, aggregates? }. The response carries `groups` and `aggregates` (null when inactive). */
export const POST: RequestHandler = async ({ params, request }) => {
	try {
		const body = await readJson(request, 64 * 1024);
		return json(
			getCollections().query(params.id, {
				filters: body.filters as never,
				sorts: body.sorts as never,
				limit: body.limit as never,
				offset: body.offset as never,
				view: typeof body.view === 'string' ? body.view : undefined,
				group_by: body.group_by as GroupBy | null | undefined,
				aggregates: body.aggregates as Aggregates | null | undefined
			})
		);
	} catch (e) {
		return fail(e);
	}
};
