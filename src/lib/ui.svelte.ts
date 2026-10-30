import type { LayerView } from './layers';

/** Small shared UI state (runes module). */
export const ui = $state({
	switcher: null as null | 'switch',
	sheet: false,
	/** mobile navigation drawer (page tree, recent, tags) */
	drawer: false,
	toast: '',
	/** optional button on the toast, e.g. "Jump to change" */
	toastAction: null as null | { label: string; run: () => void },
	/** whether the live-update stream is connected */
	live: false,
	/** pages that changed a moment ago (flashed in the tree and the recent list) */
	flash: new Set<string>(),
	/** sidebar layer filter; persisted locally, default reading */
	layerView: 'reading' as LayerView
});

const LAYER_KEY = 'stichpunkt.layers';

export function setLayerView(view: LayerView) {
	ui.layerView = view;
	try {
		localStorage.setItem(LAYER_KEY, view);
	} catch {
		/* private mode */
	}
}

export function storedLayerView(): LayerView {
	try {
		const value = localStorage.getItem(LAYER_KEY);
		if (value === 'reading' || value === 'working' || value === 'all') return value;
	} catch {
		/* private mode */
	}
	return 'reading';
}

let toastTimer: ReturnType<typeof setTimeout>;
export function toast(msg: string, action: null | { label: string; run: () => void } = null) {
	ui.toast = msg;
	ui.toastAction = action;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => ((ui.toast = ''), (ui.toastAction = null)), action ? 7000 : 3500);
}

const KEY = 'stichpunkt.recent';
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
