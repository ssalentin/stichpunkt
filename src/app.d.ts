declare global {
	namespace App {}
	/** Injected at build time by Vite `define`; see vite.config.ts and src/lib/version.ts. */
	const __STICHPUNKT_VERSION__: string;
	const __STICHPUNKT_COMMIT__: string;
}
export {};
