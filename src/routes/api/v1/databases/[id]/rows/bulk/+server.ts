import { json } from '@sveltejs/kit';
import { getCollections } from '#lib/server/collection-service';
import { MdwikiError } from '#lib/server/errors';
import { agentOf, fail, readJson } from '#lib/server/http';
import type { BulkTarget } from '#lib/server/collections';
import type { RequestHandler } from './$types';

/**
 * Change one property across many rows as a single undoable batch.
 * Body: { rows: [{ id, base_updated_at? }], values: {...}, actor?, dry_run? }
 * A conflict on any row aborts the whole batch and names the row. Dry runs answer
 * `would_update` and write nothing.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	try {
		const body = await readJson(request, 256 * 1024);
		const actor = typeof body.actor === 'string' ? body.actor : (agentOf(request) ?? 'api');
		const dryRun = body.dry_run === true;
		const result = getCollections().bulkUpdate(params.id, {
			rows: targets(body.rows),
			values: body.values,
			actor,
			dryRun
		});
		return json(dryRun ? { batch_id: result.batch_id, would_update: result.would_update } : { batch_id: result.batch_id, updated: result.updated });
	} catch (e) {
		return fail(e);
	}
};

/** The REST names rows by `id`; the store speaks `row_id`. */
function targets(raw: unknown): BulkTarget[] {
	if (!Array.isArray(raw)) throw new MdwikiError(400, 'bad_request', 'rows must be an array');
	return raw.map((entry, i) => {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new MdwikiError(400, 'bad_request', `rows[${i}] must be an object`);
		const e = entry as Record<string, unknown>;
		const id = typeof e.id === 'string' ? e.id : typeof e.row_id === 'string' ? e.row_id : '';
		if (!id) throw new MdwikiError(400, 'bad_request', `rows[${i}].id is required`);
		if (e.base_updated_at !== undefined && e.base_updated_at !== null && typeof e.base_updated_at !== 'string') {
			throw new MdwikiError(400, 'bad_request', `rows[${i}].base_updated_at must be a string`);
		}
		const base = typeof e.base_updated_at === 'string' && e.base_updated_at ? e.base_updated_at : undefined;
		return base === undefined ? { row_id: id } : { row_id: id, base_updated_at: base };
	});
}
