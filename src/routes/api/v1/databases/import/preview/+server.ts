import { json } from '@sveltejs/kit';
import { getMdwiki } from '#lib/server/service';
import { fail, readJson } from '#lib/server/http';
import { parseMarkdownTables, previewTable } from '#lib/server/collections-import';
import type { RequestHandler } from './$types';

/** Read-only preview of the tables in one page, with inferred columns. */
export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await readJson(request, 16 * 1024);
		const page = typeof body.path === 'string' ? body.path : '';
		const mdwiki = await getMdwiki();
		const view = await mdwiki.readPage(page);
		const tables = parseMarkdownTables(view.content).map((table) => previewTable(page, table));
		return json({ page: view.path, tables });
	} catch (e) {
		return fail(e);
	}
};
