import { json } from '@sveltejs/kit';
import { getCollections } from '#lib/server/collection-service';
import { agentOf, fail, readJson } from '#lib/server/http';
import type { RequestHandler } from './$types';

/**
 * Undo a bulk batch as one new batch. Body: { actor?, dry_run? }
 * A row that moved since the batch, or that the batch no longer matches, aborts the undo with a
 * 409 naming the row. A batch can only be undone once. Dry runs answer `would_undo` and write
 * nothing; `batch_id` then names the batch that was checked, not a new one.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	try {
		const body = await readJson(request, 256 * 1024);
		const actor = typeof body.actor === 'string' ? body.actor : (agentOf(request) ?? 'api');
		const dryRun = body.dry_run === true;
		const result = getCollections().undoBatch(params.id, params.batchId, actor, dryRun);
		return json(dryRun ? { batch_id: result.batch_id, would_undo: result.would_undo } : { batch_id: result.batch_id, undone: result.undone });
	} catch (e) {
		return fail(e);
	}
};
