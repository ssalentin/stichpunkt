import type { Handle } from '@sveltejs/kit/hooks';
import { checkBearer, isProtectedPath } from '#lib/server/auth';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }
	});

/** Browsers always send Origin on these calls; compare its host with the Host we were addressed by. */
function sameOrigin(request: Request, url: URL): boolean {
	const origin = request.headers.get('origin');
	if (!origin || request.headers.get('sec-fetch-site') === 'cross-site') return false;
	try {
		return new URL(origin).host === (request.headers.get('host') ?? url.host);
	} catch {
		return false;
	}
}

export const handle: Handle = async ({ event, resolve }) => {
	const t0 = performance.now();
	const { pathname } = event.url;

	if (isProtectedPath(pathname)) {
		// Authelia sits in front of the web UI only; the machine interfaces check the token themselves.
		if (!checkBearer(event.request.headers.get('authorization'), process.env.FOLIO_API_TOKEN ?? '')) {
			return json(401, { error: 'unauthorized', message: 'Bearer token required' }, {
				'www-authenticate': 'Bearer realm="folio"'
			});
		}
	} else if (pathname.startsWith('/_ui/') && !['GET', 'HEAD'].includes(event.request.method)) {
		// state-changing UI calls must come from this origin (the UI has no login of its own)
		if (!sameOrigin(event.request, event.url)) {
			return json(403, { error: 'forbidden', message: 'Cross-origin request refused' });
		}
	}

	const res = await resolve(event);
	res.headers.set('Server-Timing', `app;dur=${(performance.now() - t0).toFixed(1)}`);
	res.headers.set('X-Content-Type-Options', 'nosniff');
	res.headers.set('Referrer-Policy', 'same-origin');
	res.headers.set('X-Frame-Options', 'DENY');
	return res;
};
