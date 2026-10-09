// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from '../src/lib/client/clipboard';

afterEach(() => vi.unstubAllGlobals());

function fakeDoc(ok: boolean) {
	const ta: any = { style: {}, setAttribute() {}, select: vi.fn(), setSelectionRange() {}, remove: vi.fn() };
	const doc = {
		createElement: () => ta,
		body: { appendChild: vi.fn() },
		execCommand: vi.fn(() => ok)
	};
	return { ta, doc };
}

describe('copyText', () => {
	it('uses the async clipboard API when present', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal('navigator', { clipboard: { writeText } });
		expect(await copyText('x')).toBe(true);
		expect(writeText).toHaveBeenCalledWith('x');
	});
	it('falls back to execCommand when navigator.clipboard is undefined (insecure context)', async () => {
		const { ta, doc } = fakeDoc(true);
		vi.stubGlobal('navigator', {});
		vi.stubGlobal('document', doc);
		expect(await copyText('[[a]]')).toBe(true);
		expect(ta.value).toBe('[[a]]');
		expect(doc.execCommand).toHaveBeenCalledWith('copy');
		expect(ta.remove).toHaveBeenCalled();
	});
	it('falls back when writeText rejects', async () => {
		const { doc } = fakeDoc(true);
		vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
		vi.stubGlobal('document', doc);
		expect(await copyText('x')).toBe(true);
	});
	it('returns false when nothing works', async () => {
		const { doc } = fakeDoc(false);
		vi.stubGlobal('navigator', {});
		vi.stubGlobal('document', doc);
		expect(await copyText('x')).toBe(false);
	});
});
