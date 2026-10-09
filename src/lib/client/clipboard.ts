/** Copy text to the clipboard. Falls back to execCommand where the async API is missing (e.g. plain HTTP). */
export async function copyText(text: string): Promise<boolean> {
	if (globalThis.navigator?.clipboard) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			/* permission denied or insecure context: try the fallback */
		}
	}
	if (typeof document === 'undefined') return false;
	const ta = document.createElement('textarea');
	ta.value = text;
	ta.setAttribute('readonly', '');
	ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
	document.body.appendChild(ta);
	ta.select();
	ta.setSelectionRange(0, text.length);
	try {
		return document.execCommand('copy');
	} catch {
		return false;
	} finally {
		ta.remove();
	}
}
