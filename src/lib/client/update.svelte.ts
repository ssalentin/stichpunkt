/**
 * A deployed build replaces the service worker and takes over open pages (`controllerchange`).
 * The running page keeps its data; the reader decides when to reload, so nothing is lost mid-form.
 */
export const update = $state({ available: false, dismissed: false });

export function watchForUpdates() {
	if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {};
	// The first controllerchange is the first install claiming this page, not a new deployment.
	const hadController = !!navigator.serviceWorker.controller;
	const onChange = () => {
		if (!hadController) return;
		update.available = true;
		update.dismissed = false;
	};
	navigator.serviceWorker.addEventListener('controllerchange', onChange);
	return () => navigator.serviceWorker.removeEventListener('controllerchange', onChange);
}
