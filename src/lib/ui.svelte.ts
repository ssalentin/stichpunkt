/** Small shared UI state (runes module). */
export const ui = $state({
	switcher: null as null | 'switch' | 'new',
	sheet: false,
	/** set by the editor while mounted */
	editor: null as null | { save: () => void; saving: boolean; dirty: boolean; focused: boolean; exit: () => void },
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

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
	const res = await fetch(url, {
		method,
		headers: body === undefined || body instanceof FormData ? {} : { 'content-type': 'application/json' },
		body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body)
	});
	let data: any = null;
	try {
		data = await res.json();
	} catch {
		/* empty body */
	}
	return { status: res.status, data };
}
