import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';
import { CSP_DIRECTIVES } from './src/csp.ts';

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
	build: { chunkSizeWarningLimit: 4000 },
	test: { include: ['test/**/*.test.ts'], testTimeout: 20000 }
});
