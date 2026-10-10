import { describe, expect, it } from 'vitest';
import { absolutePaths } from '../src/lib/sw-paths';

describe('absolutePaths', () => {
	const base = 'https://example.test/service-worker.js';

	it('makes manifest paths absolute and collapses duplicates once deduplicated', () => {
		const out = [...new Set(absolutePaths(['offline.html', '_app/immutable/a.js', '/offline.html'], base))];
		expect(out).toEqual(['/offline.html', '/_app/immutable/a.js']);
		expect(out.every((p) => p.startsWith('/'))).toBe(true);
	});

	it('honours a base path', () => {
		expect(absolutePaths(['x.js'], 'https://example.test/app/service-worker.js')).toEqual(['/app/x.js']);
	});
});
