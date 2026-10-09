import { describe, expect, it } from 'vitest';
import { resolveCommit } from '../src/build-info';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('resolveCommit', () => {
	it('prefers the environment over git', () => {
		expect(resolveCommit(A, () => B)).toBe(A);
	});
	it('falls back to git when the env is unset or empty', () => {
		expect(resolveCommit(undefined, () => B + '\n')).toBe(B);
		expect(resolveCommit('', () => B)).toBe(B);
	});
	it('returns empty when git throws', () => {
		expect(resolveCommit(undefined, () => { throw new Error('no git'); })).toBe('');
	});
	it('treats invalid values as unset', () => {
		for (const bad of ['main', '<script>', 'abc123', 'g'.repeat(40), 'a'.repeat(41)]) {
			expect(resolveCommit(bad, () => ''), bad).toBe('');
			expect(resolveCommit(bad, () => B), bad).toBe(B);
		}
	});
	it('lowercases', () => {
		expect(resolveCommit('ABCDEF1234', () => '')).toBe('abcdef1234');
	});
	it('accepts length 7 and 40', () => {
		expect(resolveCommit('abcdef1', () => '')).toBe('abcdef1');
		expect(resolveCommit(A, () => '')).toBe(A);
	});
});
