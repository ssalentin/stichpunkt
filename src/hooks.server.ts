import type { Handle } from '@sveltejs/kit/hooks';
import { checkBearer, isProtectedPath } from '#lib/server/auth';

/** Set by the reverse proxy on the token router only, e.g. `X-Mdwiki-Zone: machine`. */
export const MACHINE_ZONE_HEADER = 'x-mdwiki-zone';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }
	});

export const handle: Handle = async ({ event, resolve }) => {
	const t0 = performance.now();
	const { pathname } = event.url;

	// The proxy's token router stamps this header (overwriting anything the client sent). A request that
	// came through it must authenticate for EVERY path, so a path trick such as /api/%2e%2e/_ui/page
	// cannot turn the token router into an unauthenticated route to the web UI.
	const viaTokenRouter = event.request.headers.has(MACHINE_ZONE_HEADER);

	if (viaTokenRouter || isProtectedPath(pathname)) {
		// Authelia sits in front of the web UI only; the machine interfaces check the token themselves.
		if (!checkBearer(event.request.headers.get('authorization'), process.env.MDWIKI_API_TOKEN ?? '')) {
			return json(401, { error: 'unauthorized', message: 'Bearer token required' }, {
				'www-authenticate': 'Bearer realm="mdwiki"'
			});
		}
	} else if (pathname.startsWith('/_ui/') && !['GET', 'HEAD'].includes(event.request.method)) {
		// the web UI is read only: it exposes no mutating endpoints at all
		return json(405, { error: 'read_only', message: 'The web UI is read only' }, { allow: 'GET, HEAD' });
	}

	const res = await resolve(event);
	res.headers.set('Server-Timing', `app;dur=${(performance.now() - t0).toFixed(1)}`);
	res.headers.set('X-Content-Type-Options', 'nosniff');
	res.headers.set('Referrer-Policy', 'same-origin');
	res.headers.set('X-Frame-Options', 'DENY');
	return res;
};
