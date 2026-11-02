import { describe, expect, it } from 'vitest';
import { actorSourceOf, groupByDay, selectActivity, shortNote, type FeedEntry } from '../src/lib/activity-feed';

function entry(overrides: Partial<FeedEntry> = {}): FeedEntry {
	return {
		id: 'page:index:20261102T200000000Z-abcd',
		at: '2026-11-02T20:00:00.000Z',
		actor: 'knowledge-steward',
		actorName: 'Knowledge Steward',
		actorSource: 'field',
		kind: 'page',
		action: 'write_page',
		target: 'index',
		href: '/index',
		...overrides
	};
}

describe('selectActivity', () => {
	it('orders newest first and keeps equal timestamps stable by id', () => {
		const items = selectActivity([
			entry({ id: 'a', at: '2026-11-02T10:00:00.000Z' }),
			entry({ id: 'c', at: '2026-11-02T12:00:00.000Z' }),
			entry({ id: 'b', at: '2026-11-02T12:00:00.000Z' })
		]);
		expect(items.map((item) => item.id)).toEqual(['c', 'b', 'a']);
	});

	it('filters by actor case-insensitively', () => {
		const items = selectActivity(
			[
				entry({ id: 'a', actor: 'Knowledge-Steward' }),
				entry({ id: 'b', actor: 'web-ui' })
			],
			{ actor: 'knowledge-steward' }
		);
		expect(items.map((item) => item.id)).toEqual(['a']);
	});

	it('drops entries before the since date and ignores an invalid date', () => {
		const entries = [entry({ id: 'old', at: '2026-10-01T10:00:00.000Z' }), entry({ id: 'new', at: '2026-11-02T10:00:00.000Z' })];
		expect(selectActivity(entries, { since: '2026-11-01' }).map((item) => item.id)).toEqual(['new']);
		expect(selectActivity(entries, { since: 'not-a-date' })).toHaveLength(2);
	});

	it('applies the limit after sorting and removes duplicates by id', () => {
		const items = selectActivity(
			[
				entry({ id: 'a', at: '2026-11-02T10:00:00.000Z' }),
				entry({ id: 'b', at: '2026-11-02T11:00:00.000Z' }),
				entry({ id: 'a', at: '2026-11-02T10:00:00.000Z' })
			],
			{ limit: 1 }
		);
		expect(items.map((item) => item.id)).toEqual(['b']);
	});
});

describe('groupByDay', () => {
	it('groups by the Berlin calendar day, not UTC', () => {
		const groups = groupByDay([
			entry({ id: 'late', at: '2026-11-02T23:30:00.000Z' }),
			entry({ id: 'next', at: '2026-11-03T00:30:00.000Z' })
		]);
		expect(groups.map((group) => group.day)).toEqual(['2026-11-03']);
		expect(groups[0].entries.map((item) => item.id)).toEqual(['late', 'next']);
	});

	it('starts a new group when the day changes', () => {
		const groups = groupByDay([entry({ id: 'a', at: '2026-11-02T10:00:00.000Z' }), entry({ id: 'b', at: '2026-11-01T10:00:00.000Z' })]);
		expect(groups.map((group) => group.day)).toEqual(['2026-11-02', '2026-11-01']);
		expect(groups.map((group) => group.entries.length)).toEqual([1, 1]);
	});
});

describe('actorSourceOf', () => {
	it('keeps a reported source', () => {
		expect(actorSourceOf('someone', 'token')).toBe('token');
	});

	it('classifies the app, automated writers and unlabelled actors', () => {
		expect(actorSourceOf('web-ui')).toBe('human');
		expect(actorSourceOf('deploy-gate')).toBe('system');
		expect(actorSourceOf('migration')).toBe('system');
		expect(actorSourceOf('personal-assistant')).toBe('unknown');
	});
});

describe('shortNote', () => {
	it('collapses whitespace and truncates long notes', () => {
		expect(shortNote('  Stand   bereinigt ')).toBe('Stand bereinigt');
		expect(shortNote('')).toBeUndefined();
		expect(shortNote('x'.repeat(200))).toHaveLength(160);
	});
});
