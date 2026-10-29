import { describe, expect, it } from 'vitest';
import { absolutePaths, redirectedAway } from '../src/lib/sw-paths';

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
