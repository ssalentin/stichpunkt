/** Install prompt state for Chrome's `beforeinstallprompt` (Android Chrome, desktop Chrome/Edge). */
interface InstallPromptEvent extends Event {
	prompt(): Promise<void>;
	userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export const pwa = $state({ canInstall: false });

let deferred: InstallPromptEvent | null = null;

export function listenForInstall() {
	const onPrompt = (e: Event) => {
		e.preventDefault(); // keep it for our own button instead of Chrome's mini-infobar
		deferred = e as InstallPromptEvent;
		pwa.canInstall = true;
	};
	const onInstalled = () => {
		deferred = null;
		pwa.canInstall = false;
	};
	window.addEventListener('beforeinstallprompt', onPrompt);
	window.addEventListener('appinstalled', onInstalled);
	return () => {
		window.removeEventListener('beforeinstallprompt', onPrompt);
		window.removeEventListener('appinstalled', onInstalled);
	};
}

export async function install() {
	if (!deferred) return;
	const ev = deferred;
	deferred = null; // a prompt event can only be used once
	pwa.canInstall = false;
	await ev.prompt();
	await ev.userChoice.catch(() => {});
}
