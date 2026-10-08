import { json } from '@sveltejs/kit';
import { getMdwiki } from '#lib/server/service';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => json((await getMdwiki()).listTags(), { headers: { 'cache-control': 'no-store' } });
