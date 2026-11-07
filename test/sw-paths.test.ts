import { describe, expect, it } from 'vitest';
import { absolutePaths, pageCacheKey, redirectedAway } from '../src/lib/sw-paths';

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

describe('redirectedAway', () => {
	it('detects a followed redirect to another URL (SSO login)', () => {
		expect(redirectedAway('https://example.test/Notes/A', 'https://auth.example.test/login?rd=1', true)).toBe(true);
	});

	it('does not treat a plain response or a same-URL response as redirected away', () => {
		expect(redirectedAway('https://example.test/Notes/A', 'https://example.test/Notes/A', true)).toBe(false);
		expect(redirectedAway('https://example.test/Notes/A', 'https://auth.example.test/login', false)).toBe(false);
	});
});

describe('pageCacheKey', () => {
	it('maps the PWA start URL onto the plain start page', () => {
		expect(pageCacheKey('https://example.test/?source=pwa')).toBe(pageCacheKey('https://example.test/'));
	});

	it('keeps real query parameters such as filters and sorts', () => {
		expect(pageCacheKey('https://example.test/databases/x?p0=Status&v0=Read&sort=Year:desc')).toBe(
			'https://example.test/databases/x?p0=Status&v0=Read&sort=Year:desc'
		);
	});

	it('drops campaign parameters and the fragment', () => {
		expect(pageCacheKey('https://example.test/Notes/A?utm_source=x&utm_medium=y#top')).toBe('https://example.test/Notes/A');
	});
});
