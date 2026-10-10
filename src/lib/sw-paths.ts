/** Resolve manifest paths (relative to the base path in SvelteKit 3) to absolute pathnames. */
export function absolutePaths(paths: string[], base: string): string[] {
	return paths.map((p) => new URL(p, base).pathname);
}
