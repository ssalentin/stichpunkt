import { getCollections } from '#lib/server/collection-service';
import { loadConfig } from '#lib/server/config';
import { buildInstanceExport } from '#lib/server/instance-export';
import { fail } from '#lib/server/http';
import type { RequestHandler } from './$types';

/**
 * Download the whole instance as one JSON bundle: every page, every collection, with the export
 * format version and the timestamp in the header. `npm run export` writes the same bundle as a
 * directory tree. Restore procedure: docs/export.md. Read-only.
 */
export const GET: RequestHandler = async () => {
	try {
		const now = new Date();
		const bundle = await buildInstanceExport(getCollections(), loadConfig().spaceDir, now);
		return new Response(JSON.stringify(bundle, null, 2), {
			headers: {
				'content-type': 'application/json; charset=utf-8',
				'content-disposition': `attachment; filename="stichpunkt-export-${now.toISOString().slice(0, 10)}.json"`,
				'cache-control': 'no-store'
			}
		});
	} catch (e) {
		return fail(e);
	}
};
