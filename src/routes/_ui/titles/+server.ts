import { json } from '@sveltejs/kit';
import { getFolio } from '#lib/server/service';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => json((await getFolio()).titles(), { headers: { 'cache-control': 'no-store' } });
