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

/**
 * Cache key for a page: the URL without the install-source marker and campaign parameters.
 * The manifest starts the app at `/?source=pwa`, while the plain start page is cached as `/`;
 * without normalising, an offline launch from the home screen misses the cache and lands on
 * the offline page. Real query parameters (filters, sorts, offsets) stay part of the key.
 */
export function pageCacheKey(raw: string): string {
	const url = new URL(raw);
	for (const key of [...url.searchParams.keys()]) {
		if (key === 'source' || key.startsWith('utm_')) url.searchParams.delete(key);
	}
	url.hash = '';
	return url.toString();
}
