import { json } from '@sveltejs/kit';
import { runHealthChecks } from '#lib/server/health';
import type { RequestHandler } from './$types';

/**
 * Liveness and readiness in one answer: 200 when the database is intact, writable and the last
 * backup is fresh; 503 otherwise. Public on purpose, so the deploy script and an uptime monitor can
 * call it without a token. The body carries no paths, tokens or content.
 */
export const GET: RequestHandler = () => {
	const { status, body } = runHealthChecks();
	return json(body, { status, headers: { 'cache-control': 'no-store' } });
};
