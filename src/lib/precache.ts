// Cache.addAll() rejects requests that resolve to the same URL, so dedupe on resolved URLs, not on raw strings.
export function precacheUrls(base: string, ...lists: string[][]): string[] {
	return [...new Set(lists.flat().map((p) => new URL(p, base).href))];
}
