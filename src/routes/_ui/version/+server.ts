import { json } from '@sveltejs/kit';
import { APP_COMMIT, APP_VERSION } from '#lib/version';
import type { RequestHandler } from './$types';

/** Which build the server runs. The page compares this with its own build to decide on the hint. */
export const GET: RequestHandler = () =>
	json({ build: APP_COMMIT || APP_VERSION || 'unknown' }, { headers: { 'cache-control': 'no-store' } });
