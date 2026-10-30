import { json } from '@sveltejs/kit';
import { fail } from '#lib/server/http';
import { getMdwiki } from '#lib/server/service';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	try {
		const mdwiki = await getMdwiki();
		const bool = (name: string) => ['1', 'true', 'yes'].includes((url.searchParams.get(name) ?? '').toLowerCase());
		const num = (name: string) => {
			const value = Number.parseInt(url.searchParams.get(name) ?? '', 10);
			return Number.isFinite(value) ? value : undefined;
		};
		return json(
			mdwiki.listPagesResult(url.searchParams.get('prefix') ?? '', {
				includeWorking: bool('include_working'),
				limit: num('limit'),
				offset: num('offset')
			})
		);
	} catch (e) {
		return fail(e);
	}
};
