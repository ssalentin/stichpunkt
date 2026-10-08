/** Small shared UI state (runes module). */
export const ui = $state({
	switcher: null as null | 'switch',
	sheet: false,
	toast: ''
});

let toastTimer: ReturnType<typeof setTimeout>;
export function toast(msg: string) {
	ui.toast = msg;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => (ui.toast = ''), 3500);
}

const KEY = 'mdwiki.recent';
export function recentPages(): string[] {
	try {
		return JSON.parse(localStorage.getItem(KEY) ?? '[]');
	} catch {
		return [];
	}
}
export function visit(path: string) {
	const list = [path, ...recentPages().filter((p) => p !== path)].slice(0, 30);
	try {
		localStorage.setItem(KEY, JSON.stringify(list));
	} catch {
		/* private mode */
	}
}
