/** Build identity, injected by Vite `define` (see vite.config.ts). No Node imports: this ships to the client. */
export const APP_VERSION: string = __STICHPUNKT_VERSION__;
export const APP_COMMIT: string = __STICHPUNKT_COMMIT__;

export function shortCommit(): string {
	return APP_COMMIT ? APP_COMMIT.slice(0, 7) : 'unknown';
}

/** `0.1.0+09b2d21`, or just `0.1.0` when the commit is unknown. */
export function mcpVersion(): string {
	return APP_COMMIT ? `${APP_VERSION}+${APP_COMMIT.slice(0, 7)}` : APP_VERSION;
}
