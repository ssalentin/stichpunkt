const SHA = /^[0-9a-f]{7,40}$/;

function valid(value: string | undefined): string {
	const v = (value ?? '').trim().toLowerCase();
	return SHA.test(v) ? v : '';
}

/**
 * The commit the build comes from, decided at build time by `vite.config.ts`.
 *
 * `STICHPUNKT_COMMIT` wins, then `git rev-parse HEAD`; anything that is not 7-40 hex characters
 * counts as unset. Returns the lowercase SHA or `''` — never throws, so a missing git never
 * breaks a build.
 */
export function resolveCommit(fromEnv: string | undefined, fromGit: () => string): string {
	const env = valid(fromEnv);
	if (env) return env;
	try {
		return valid(fromGit());
	} catch {
		return '';
	}
}
