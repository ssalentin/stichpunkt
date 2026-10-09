import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';
import { resolveCommit } from './src/build-info.ts';
import { CSP_DIRECTIVES } from './src/csp.ts';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const commit = resolveCommit(process.env.STICHPUNKT_COMMIT, () =>
	execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
);

export default defineConfig({
	plugins: [
		sveltekit({
			adapter: adapter(),
			// Hardening below the escaping: content pages get a real CSP. SvelteKit augments the
			// inline hydration scripts (and transitions) with a nonce/hash of its own, so they must
			// come from `kit.csp`, not a hand-built header in hooks.server.ts. The sandbox CSPs on
			// /f/* and /_ui/diagram/* stay untouched.
			csp: {
				mode: 'auto',
				directives: CSP_DIRECTIVES
			}
		})
	],
	define: {
		__STICHPUNKT_VERSION__: JSON.stringify(version),
		__STICHPUNKT_COMMIT__: JSON.stringify(commit)
	},
	build: { chunkSizeWarningLimit: 4000 },
	test: { include: ['test/**/*.test.ts'], testTimeout: 20000 }
});
