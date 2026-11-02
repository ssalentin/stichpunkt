import { getCollections } from '#lib/server/collection-service';
import { exportCollection, exportCollectionCsv, exportFilename } from '#lib/server/collections-export';
import { MdwikiError } from '#lib/server/errors';
import { fail } from '#lib/server/http';
import type { RequestHandler } from './$types';

/**
 * Download one collection as a portable snapshot.
 *
 * `?format=csv` (default) returns the rows as a spreadsheet-friendly table; `?format=json` keeps
 * property types, options and row ids so the export can be re-imported or diffed. Read-only.
 */
export const GET: RequestHandler = async ({ params, url }) => {
	try {
		const format = url.searchParams.get('format') ?? 'csv';
		if (format !== 'csv' && format !== 'json') {
			throw new MdwikiError(400, 'bad_format', 'format must be "csv" or "json"');
		}
		const store = getCollections();
		const collection = store.get(params.id);
		const { ascii, encoded } = exportFilename(collection.name, format);
		const body = format === 'json' ? JSON.stringify(exportCollection(store, params.id), null, 2) : exportCollectionCsv(store, params.id);
		const type = format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8';
		return new Response(body, {
			headers: {
				'content-type': type,
				'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
				'cache-control': 'no-store'
			}
		});
	} catch (e) {
		return fail(e);
	}
};
