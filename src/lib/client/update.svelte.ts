/**
 * A deployed build replaces the service worker and takes over open pages (`controllerchange`).
 * The running page keeps its data; the reader decides when to reload, so nothing is lost mid-form.
 */

import { APP_COMMIT, APP_VERSION } from '../version';

export const UPDATE_DISMISSED_KEY = 'stichpunkt.update.dismissed';

/** Identity of the build this page runs; a dismissal only applies to exactly this build. */
export function runningBuild(): string {
	return APP_COMMIT || APP_VERSION || 'unknown';
}

export const update = $state({ available: false, dismissed: false });

/**
 * Dismiss the hint for the running build. It stays hidden until the page reloads onto a new
 * build; the stored key is ignored as soon as the running build differs.
 */
export function dismissUpdate() {
	update.dismissed = true;
	try {
		localStorage.setItem(UPDATE_DISMISSED_KEY, runningBuild());
	} catch {
		/* private mode or storage disabled: the in-memory flag still hides it for this page */
	}
}

function dismissedForRunningBuild(): boolean {
	try {
		return typeof localStorage !== 'undefined' && localStorage.getItem(UPDATE_DISMISSED_KEY) === runningBuild();
	} catch {
		return false;
	}
}

export function watchForUpdates() {
	if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {};
	// A dismissal persists for this build across reloads and suppresses every further
	// controllerchange in this tab until the page runs a different build.
	update.dismissed = dismissedForRunningBuild();
	// Only the first controllerchange can be the first install claiming this page. When the page
	// was opened before any worker existed, the controller is null now but a later deployment
	// must still be announced, so the flag flips with the first event, not the initial state.
	let seen = !!navigator.serviceWorker.controller;
	const onChange = () => {
		if (!seen) {
			seen = true;
			return;
		}
		if (update.dismissed) return;
		update.available = true;
	};
	navigator.serviceWorker.addEventListener('controllerchange', onChange);
	return () => navigator.serviceWorker.removeEventListener('controllerchange', onChange);
}
