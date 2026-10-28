/**
 * A deployed build replaces the service worker and takes over open pages (`controllerchange`).
 * The running page keeps its data; the reader decides when to reload, so nothing is lost mid-form.
 */
export const update = $state({ available: false, dismissed: false });

export function watchForUpdates() {
	if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {};
	// Only the first controllerchange can be the first install claiming this page. When the page
	// was opened before any worker existed, the controller is null now but a later deployment
	// must still be announced, so the flag flips with the first event, not the initial state.
	let seen = !!navigator.serviceWorker.controller;
	const onChange = () => {
		if (!seen) {
			seen = true;
			return;
		}
		update.available = true;
		update.dismissed = false;
	};
	navigator.serviceWorker.addEventListener('controllerchange', onChange);
	return () => navigator.serviceWorker.removeEventListener('controllerchange', onChange);
}
