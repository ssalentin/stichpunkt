/** Resolve manifest paths (relative to the base path in SvelteKit 3) to absolute pathnames. */
export function absolutePaths(paths: string[], base: string): string[] {
	return paths.map((p) => new URL(p, base).pathname);
}

/**
 * True when the network answered after following a redirect to a different URL. An SSO login
 * redirect must neither be cached under the requested page nor served as its content.
 */
export function redirectedAway(requestUrl: string, responseUrl: string, redirected: boolean): boolean {
	return redirected && responseUrl !== requestUrl;
}
