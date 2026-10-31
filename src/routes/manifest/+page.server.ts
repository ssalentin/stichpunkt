import { getMdwiki } from '#lib/server/service';
import type { PageServerLoad } from './$types';

/** The fixed system console for the space's MANIFEST page. Read-only, like every other UI route. */
export const load: PageServerLoad = async () => {
	const mdwiki = await getMdwiki();
	return { manifest: await mdwiki.manifestView() };
};
