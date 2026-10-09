// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectiveTheme, setTheme, storedTheme } from '../src/lib/client/theme';

const ROOT = path.resolve(__dirname, '..');

function fakeBrowser(stored: string | null, prefersLight = false) {
	const store = new Map<string, string>(stored ? [['stichpunkt.theme', stored]] : []);
	const metas: any[] = [];
	const root: any = { dataset: {} as Record<string, string> };
	const document: any = {
		documentElement: root,
		head: { appendChild: (m: any) => metas.push(m) },
		createElement: () => {
			const m: any = { remove: () => metas.splice(metas.indexOf(m), 1) };
			return m;
		},
		querySelector: () => metas[0] ?? null,
		querySelectorAll: () => ({ forEach: (f: (m: any) => void) => [...metas].forEach(f) })
	};
	const localStorage = {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k)
	};
	const window = { matchMedia: () => ({ matches: prefersLight }) };
	return { store, metas, root, document, localStorage, window };
}

afterEach(() => vi.unstubAllGlobals());

describe('theme selector', () => {
	it('defaults to system and ignores junk in storage', () => {
		vi.stubGlobal('localStorage', fakeBrowser(null).localStorage);
		expect(storedTheme()).toBe('system');
		vi.stubGlobal('localStorage', fakeBrowser('neon').localStorage);
		expect(storedTheme()).toBe('system');
	});

	it('persists an explicit choice and sets data-theme', () => {
		const b = fakeBrowser(null);
		vi.stubGlobal('localStorage', b.localStorage);
		vi.stubGlobal('document', b.document);
		setTheme('light');
		expect(b.store.get('stichpunkt.theme')).toBe('light');
		expect(b.root.dataset.theme).toBe('light');
		expect(storedTheme()).toBe('light');
		expect(b.metas).toHaveLength(1);
	});

	it('system clears the override again', () => {
		const b = fakeBrowser('dark');
		vi.stubGlobal('localStorage', b.localStorage);
		vi.stubGlobal('document', b.document);
		b.root.dataset.theme = 'dark';
		setTheme('system');
		expect(b.store.has('stichpunkt.theme')).toBe(false);
		expect(b.root.dataset.theme).toBeUndefined();
		expect(b.metas).toHaveLength(2);
	});

	it('resolves system against the OS preference', () => {
		for (const [light, want] of [[true, 'light'], [false, 'dark']] as const) {
			const b = fakeBrowser(null, light);
			vi.stubGlobal('document', b.document);
			vi.stubGlobal('window', b.window);
			expect(effectiveTheme()).toBe(want);
		}
	});
});

describe('pre-paint theme-init script', () => {
	const src = fs.readFileSync(path.join(ROOT, 'static/theme-init.js'), 'utf8');
	const run = (stored: string | null) => {
		const b = fakeBrowser(stored);
		vm.runInNewContext(src, { document: b.document, localStorage: b.localStorage });
		return b;
	};

	it('applies a stored light/dark choice', () => {
		expect(run('light').root.dataset.theme).toBe('light');
		expect(run('dark').root.dataset.theme).toBe('dark');
	});

	it('leaves system and junk values alone', () => {
		expect(run(null).root.dataset.theme).toBeUndefined();
		expect(run('neon').root.dataset.theme).toBeUndefined();
	});

	it('is loaded as an external script, because the CSP forbids inline ones', () => {
		const html = fs.readFileSync(path.join(ROOT, 'src/app.html'), 'utf8');
		expect(html).toContain('<script src="/theme-init.js"></script>');
	});
});
