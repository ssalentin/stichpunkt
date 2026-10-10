import { describe, expect, it } from 'vitest';
import { toPathname } from '../src/lib/precache';

describe('toPathname', () => {
	const base = 'https://example.test/service-worker.js';

	it('resolves relative and absolute spellings of offline.html to one pathname', () => {
		expect(toPathname('offline.html', base)).toBe('/offline.html');
		expect(toPathname('/offline.html', base)).toBe('/offline.html');
	});

	it('resolves immutable build paths to absolute pathnames', () => {
		expect(toPathname('_app/immutable/x.js', base)).toBe('/_app/immutable/x.js');
	});

	it('collapses a mapped list with both spellings to one Set entry (Cache.addAll rejects duplicates)', () => {
		const list = ['offline.html', '/offline.html'].map((p) => toPathname(p, base));
		expect(new Set(list).size).toBe(1);
	});
});
