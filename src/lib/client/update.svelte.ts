/**
 * A deployed build replaces the service worker and takes over open pages (`controllerchange`).
 * The running page keeps its data; the reader decides when to reload, so nothing is lost mid-form.
 *
 * A worker takeover alone is not proof that this page runs an old build: the browser also
 * claims pages that already loaded the new build. The hint therefore compares the build of
 * the page with the build the server reports, and a reload onto the new build stays quiet.
 */

import { APP_COMMIT, APP_VERSION } from '../version';

export const UPDATE_DISMISSED_KEY = 'stichpunkt.update.dismissed';
export const UPDATE_CHECK_URL = '/_ui/version';

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
	update.available = false;
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

/**
 * Compare this page with the running server. The hint appears only for a different build, so
 * reloading onto the new build clears it instead of bringing it back. A failed request (offline,
 * a restarting service) leaves the current state untouched.
 */
export async function checkForUpdate(): Promise<void> {
	if (typeof fetch !== 'function') return;
	try {
		const res = await fetch(UPDATE_CHECK_URL, { cache: 'no-store', headers: { accept: 'application/json' } });
		if (!res.ok) return;
		const body = (await res.json()) as { build?: unknown };
		if (typeof body.build !== 'string' || body.build === '') return;
		update.available = body.build !== runningBuild() && !update.dismissed;
	} catch {
		/* offline or a restarting server: keep what the page already shows */
	}
}

export function watchForUpdates() {
	if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {};
	update.dismissed = dismissedForRunningBuild();
	const doc = typeof document === 'undefined' ? null : document;

	// A takeover only triggers a check; the server's build decides.
	const onChange = () => void checkForUpdate();
	const onVisible = () => {
		if (typeof document !== 'undefined' && !document.hidden) void checkForUpdate();
	};
	navigator.serviceWorker.addEventListener('controllerchange', onChange);
	doc?.addEventListener('visibilitychange', onVisible);
	void checkForUpdate();

	return () => {
		navigator.serviceWorker.removeEventListener('controllerchange', onChange);
		doc?.removeEventListener('visibilitychange', onVisible);
	};
}
