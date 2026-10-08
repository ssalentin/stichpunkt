import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		sveltekit({
			adapter: adapter()
		})
	],
	build: { chunkSizeWarningLimit: 4000 },
	test: { include: ['test/**/*.test.ts'], testTimeout: 20000 }
});
