/**
 * Live reload client: listens to `/_ui/events` (server-sent events) and tells the app when the
 * content changed. The stream only names the changed pages; the app reloads its data through
 * the normal page requests, so the service worker and the auth in front of the UI stay in charge.
 */
export interface LiveHandlers {
	/** content changed; `paths` is null when changes were possibly missed (reconnect, restart) */
	onChange(paths: string[] | null): void;
	onStatus?(connected: boolean): void;
}

interface Hello {
	boot: string;
	version: number;
}
interface Change extends Hello {
	paths: string[];
}

const RETRY_MIN = 3000;
const RETRY_MAX = 60000;

export function startLive(h: LiveHandlers, url = '/_ui/events'): () => void {
	if (typeof EventSource === 'undefined') return () => {};
	let es: EventSource | null = null;
	let seen: Hello | null = null;
	/** changes that arrived while the tab was hidden; null = none, [] with `all` = unknown */
	let held: Set<string> | null = null;
	let heldAll = false;
	/** EventSource only retries network errors; after a non-200 answer (502 while the server restarts) it gives up, so we reconnect ourselves */
	let timer: ReturnType<typeof setTimeout> | null = null;
	let delay = RETRY_MIN;
	let stopped = false;

	const deliver = (paths: string[] | null) => {
		if (document.hidden) {
			held ??= new Set();
			if (paths) for (const p of paths) held.add(p);
			else heldAll = true;
			return;
		}
		h.onChange(paths);
	};

	const schedule = () => {
		if (stopped || timer) return;
		timer = setTimeout(() => {
			timer = null;
			connect();
		}, delay * (1 + Math.random() * 0.2));
		delay = Math.min(delay * 2, RETRY_MAX);
	};

	/** a closed connection waits for its timer; try right away instead (tab visible again, network back) */
	const retryNow = () => {
		if (stopped || !timer) return;
		clearTimeout(timer);
		timer = null;
		delay = RETRY_MIN;
		connect();
	};

	const connect = () => {
		es?.close();
		const source = (es = new EventSource(url));
		source.onopen = () => {
			delay = RETRY_MIN;
			h.onStatus?.(true);
		};
		source.onerror = () => {
			h.onStatus?.(false);
			// readyState CONNECTING means the browser is retrying by itself
			if (source.readyState === EventSource.CLOSED) {
				source.close();
				schedule();
			}
		};
		es.addEventListener('hello', (e) => {
			const hello = JSON.parse((e as MessageEvent).data) as Hello;
			// a reconnect that finds a different version (or a restarted server) missed changes
			if (seen && (seen.boot !== hello.boot || seen.version !== hello.version)) deliver(null);
			seen = hello;
		});
		es.addEventListener('change', (e) => {
			const c = JSON.parse((e as MessageEvent).data) as Change;
			seen = { boot: c.boot, version: c.version };
			deliver(c.paths);
		});
	};

	const onVisible = () => {
		if (document.hidden) return;
		retryNow();
		if (!held) return;
		const paths = heldAll ? null : [...held];
		held = null;
		heldAll = false;
		h.onChange(paths);
	};
	document.addEventListener('visibilitychange', onVisible);
	window.addEventListener('online', retryNow);
	connect();

	return () => {
		stopped = true;
		if (timer) clearTimeout(timer);
		timer = null;
		document.removeEventListener('visibilitychange', onVisible);
		window.removeEventListener('online', retryNow);
		es?.close();
	};
}

/**
 * Marks what changed between two renderings of one page by adding `className` to the live
 * elements under `root`. Blocks that are identical are left alone; inside a changed block the
 * walk descends while the structure matches, so one edited list item flashes, not the whole
 * page. Returns the first marked element (or null), so the caller can offer to scroll to it.
 */
export function markChanges(root: HTMLElement, oldHtml: string, newHtml: string, className: string): HTMLElement | null {
	const parse = (html: string) => {
		const box = document.createElement('div');
		box.innerHTML = html;
		return box;
	};
	const before = parse(oldHtml);
	const after = parse(newHtml);
	const live = [...root.children] as HTMLElement[];
	const o = [...before.children];
	const n = [...after.children];
	if (n.length !== live.length) return null; // the live DOM was rewritten by something else: do not guess
	let first: HTMLElement | null = null;
	const flag = (el: HTMLElement) => {
		el.classList.add(className);
		first ??= el;
	};

	if (o.length === n.length) {
		n.forEach((el, i) => walk(o[i], el, live[i], 0, flag));
	} else {
		// blocks were added or removed: any block whose markup did not exist before is new
		const known = new Map<string, number>();
		for (const el of o) known.set(el.outerHTML, (known.get(el.outerHTML) ?? 0) + 1);
		n.forEach((el, i) => {
			const left = known.get(el.outerHTML) ?? 0;
			if (left > 0) known.set(el.outerHTML, left - 1);
			else flag(live[i]);
		});
	}
	return first;
}

const MAX_DEPTH = 3;

function shallow(el: Element): string {
	const text = [...el.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join('\u0000');
	return `${(el.cloneNode(false) as Element).outerHTML}${text}`;
}

function walk(o: Element, n: Element, live: HTMLElement, depth: number, flag: (el: HTMLElement) => void): void {
	if (o.outerHTML === n.outerHTML) return;
	const oc = [...o.children];
	const nc = [...n.children];
	const lc = [...live.children] as HTMLElement[];
	const sameShape = depth < MAX_DEPTH && nc.length > 0 && oc.length === nc.length && lc.length === nc.length && shallow(o) === shallow(n);
	if (!sameShape) return flag(live);
	nc.forEach((el, i) => walk(oc[i], el, lc[i], depth + 1, flag));
}
