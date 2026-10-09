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
	// as in app.html: one media-conditional tag per scheme
	for (const [media, content] of [['(prefers-color-scheme: dark)', '#0e1116'], ['(prefers-color-scheme: light)', '#f6f3ec']]) {
		const m: any = { name: 'theme-color', media, content, remove: () => metas.splice(metas.indexOf(m), 1) };
		metas.push(m);
	}
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
		expect(b.metas[0].content).toBe('#f6f3ec');
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

	it('leaves exactly one theme-color tag for the stored choice', () => {
		const b = run('dark');
		expect(b.metas).toHaveLength(1);
		expect(b.metas[0].content).toBe('#0e1116');
		expect(b.metas[0].media).toBeUndefined();
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

describe('palette in app.css', () => {
	const css = fs.readFileSync(path.join(ROOT, 'src/app.css'), 'utf8');
	const vars = (block: string) => [...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => `${m[1]}:${m[2].trim()}`).sort();

	it('has a single prefers-color-scheme query, so theme colours live in the palette blocks only', () => {
		expect(css.match(/prefers-color-scheme/g)).toHaveLength(1);
	});

	it('declares the same light palette for the OS query and for data-theme=light', () => {
		const media = css.match(/@media \(prefers-color-scheme: light\) \{\s*:root:not\(\[data-theme\]\) \{([^}]*)\}/);
		const explicit = css.match(/:root\[data-theme='light'\] \{([^}]*)\}/);
		expect(media).not.toBeNull();
		expect(explicit).not.toBeNull();
		expect(vars(media![1])).toEqual(vars(explicit![1]));
	});

	it('defines every light variable (incl. syntax colours) in the dark default as well', () => {
		const dark = css.match(/^:root \{([^}]*)\}/m)![1];
		const light = css.match(/:root\[data-theme='light'\] \{([^}]*)\}/)![1];
		const names = (b: string) => vars(b).map((v) => v.split(':')[0]);
		for (const n of names(light).filter((n) => n !== '--bar-h')) expect(names(dark)).toContain(n);
	});
});
