export type Theme = 'system' | 'light' | 'dark';

export const THEMES: { value: Theme; label: string }[] = [
	{ value: 'system', label: 'System' },
	{ value: 'light', label: 'Light' },
	{ value: 'dark', label: 'Dark' }
];

// keep in sync with static/theme-init.js, which applies the stored choice before first paint
const KEY = 'stichpunkt.theme';
const COLORS = { dark: '#0e1116', light: '#f6f3ec' };

export function storedTheme(): Theme {
	try {
		const t = localStorage.getItem(KEY);
		return t === 'light' || t === 'dark' ? t : 'system';
	} catch {
		return 'system';
	}
}

/** Apply and persist a choice. `system` removes the override so the OS preference decides. */
export function setTheme(theme: Theme) {
	const root = document.documentElement;
	try {
		if (theme === 'system') localStorage.removeItem(KEY);
		else localStorage.setItem(KEY, theme);
	} catch {
		/* private mode: the choice lasts for this page view only */
	}
	if (theme === 'system') delete root.dataset.theme;
	else root.dataset.theme = theme;

	// an explicit choice replaces the media-conditional theme-color tags with a single one
	document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
	if (theme === 'system') {
		for (const scheme of ['dark', 'light'] as const) {
			const m = document.createElement('meta');
			m.name = 'theme-color';
			m.content = COLORS[scheme];
			m.media = `(prefers-color-scheme: ${scheme})`;
			document.head.appendChild(m);
		}
	} else {
		const m = document.createElement('meta');
		m.name = 'theme-color';
		m.content = COLORS[theme];
		document.head.appendChild(m);
	}
}

/** The theme in effect right now, after resolving `system` against the OS preference. */
export function effectiveTheme(): 'light' | 'dark' {
	const t = document.documentElement.dataset.theme;
	if (t === 'light' || t === 'dark') return t;
	return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
