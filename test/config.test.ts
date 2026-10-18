import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/lib/server/config';

describe('space configuration', () => {
	it('uses the fallback when the configured space is empty', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stichpunkt-config-'));
		try {
			const space = path.join(root, 'space');
			const fallback = path.join(root, 'examples');
			fs.mkdirSync(space);
			fs.mkdirSync(fallback);
			fs.writeFileSync(path.join(fallback, 'Page.md'), '# Page\n');

			const config = loadConfig({ SPACE_DIR: space, SPACE_FALLBACK_DIR: fallback });
			expect(config.spaceDir).toBe(fallback);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it('keeps a non-empty configured space authoritative', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stichpunkt-config-'));
		try {
			const space = path.join(root, 'space');
			const fallback = path.join(root, 'examples');
			fs.mkdirSync(space);
			fs.mkdirSync(fallback);
			fs.writeFileSync(path.join(space, 'Live.md'), '# Live\n');
			fs.writeFileSync(path.join(fallback, 'Example.md'), '# Example\n');

			const config = loadConfig({ SPACE_DIR: space, SPACE_FALLBACK_DIR: fallback });
			expect(config.spaceDir).toBe(space);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
