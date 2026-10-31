import { getCollections } from '#lib/server/collection-service';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	return { databases: getCollections().list() };
};
