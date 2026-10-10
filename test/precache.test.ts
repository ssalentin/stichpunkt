import { describe, expect, it } from 'vitest';
import { precacheUrls } from '../src/lib/precache';

describe('precacheUrls', () => {
	const base = 'https://example.test';

	it('collapses relative and absolute spellings of the same file (Cache.addAll rejects duplicates)', () => {
		const urls = precacheUrls(base, ['offline.html', 'a.js'], ['/offline.html'], ['/offline.html']);
		expect(urls).toEqual(['https://example.test/offline.html', 'https://example.test/a.js']);
		expect(new Set(urls).size).toBe(urls.length);
	});
});
