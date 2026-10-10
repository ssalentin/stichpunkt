import type { Config } from '@sveltejs/kit/vite';

type CspDirectives = NonNullable<Config['csp']>['directives'];

/**
 * The Content-Security-Policy for content pages, as a single source of truth.
 *
 * `vite.config.ts` hands this to SvelteKit's `kit.csp`, which augments the inline
 * hydration scripts (and transitions) with a nonce/hash of its own. The sandbox CSPs
 * on `/f/*` and `/_ui/diagram/*` are set by their route handlers and stay untouched.
 */
export const CSP_DIRECTIVES: CspDirectives = {
	'default-src': ['self'],
	// no 'unsafe-inline' / 'unsafe-eval' — SvelteKit adds a nonce or hash instead
	'script-src': ['self'],
	'style-src': ['self', 'unsafe-inline'],
	'img-src': ['self', 'data:', 'blob:'],
	'font-src': ['self', 'data:'],
	'connect-src': ['self'],
	// the service worker registers from this origin
	'worker-src': ['self'],
	'object-src': ['none'],
	'base-uri': ['none'],
	'form-action': ['self'],
	'frame-ancestors': ['none']
};
