import { fail } from '@sveltejs/kit';
import { MANIFEST_PAGE } from '#lib/server/agent-manifest';
import { MdwikiError } from '#lib/server/errors';
import { manifestWriteEnabled, manifestWriteRefusal } from '#lib/server/manifest-write';
import { getMdwiki } from '#lib/server/service';
import type { Actions, PageServerLoad } from './$types';

/** The fixed system console for the space's MANIFEST page. */
export const load: PageServerLoad = async () => {
	const mdwiki = await getMdwiki();
	return { manifest: await mdwiki.manifestView(), canEdit: manifestWriteEnabled() };
};

export const actions: Actions = {
	save: async ({ request }) => {
		const refusal = manifestWriteRefusal(request.headers);
		if (refusal) return fail(403, { error: refusal, content: '', issues: [] });
		const form = await request.formData();
		const content = form.get('content');
		const baseHash = form.get('base_hash');
		if (typeof content !== 'string' || content.trim() === '') {
			return fail(400, { error: 'The manifest must not be empty.', content: typeof content === 'string' ? content : '', issues: [] });
		}
		if (typeof baseHash !== 'string' || baseHash === '') {
			return fail(400, { error: 'Missing version. Reload the page and try again.', content, issues: [] });
		}
		try {
			const mdwiki = await getMdwiki();
			// the UI act goes in as its own actor, so the history shows where a change came from
			const res = await mdwiki.writePage(MANIFEST_PAGE, content, baseHash, 'web-ui', 'manifest console');
			return { saved: true as const, hash: res.hash, content, issues: [], warnings: res.warnings.map((w) => w.message) };
		} catch (err) {
			if (err instanceof MdwikiError) {
				const issues = Array.isArray(err.details?.issues)
					? (err.details.issues as { path: (string | number)[]; message: string }[])
					: [];
				return fail(err.status === 409 ? 409 : 400, {
					error:
						err.status === 409
							? 'The manifest changed while you were editing. Copy your text, reload, and merge it.'
							: err.message,
					issues,
					content
				});
			}
			throw err;
		}
	}
};
