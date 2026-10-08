import { json } from '@sveltejs/kit';
import { getFolio } from '#lib/server/service';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => json((await getFolio()).listTags(), { headers: { 'cache-control': 'no-store' } });
