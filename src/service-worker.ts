/// <reference lib="webworker" />
import { version } from '$app/env';
import { assets, immutable } from '$app/manifest';

declare const self: ServiceWorkerGlobalScope;

const build: string[] = immutable.map((f) => f.path);
const files: string[] = assets.map((f) => f.path);

const SHELL = `shell-${version}`;
const PAGES = 'pages-v1';
const MAX_PAGES = 50;
const MAX_ASSETS = 100;
const ASSETS = 'assets-v1';

// Never cache the machine interfaces or mutating UI calls.
const skip = (url: URL) => /^\/(api|mcp)(\/|$)/.test(url.pathname) || url.pathname.startsWith('/_ui/') && !url.pathname.startsWith('/_ui/diagram/');

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(SHELL)
			.then((c) => c.addAll([...build, ...files]))
			.then(() => self.skipWaiting())
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k.startsWith('shell-') && k !== SHELL).map((k) => caches.delete(k))))
			.then(() => self.clients.claim())
	);
});

async function put(name: string, limit: number, req: Request, res: Response) {
	const cache = await caches.open(name);
	await cache.put(req, res);
	const keys = await cache.keys();
	for (const k of keys.slice(0, Math.max(0, keys.length - limit))) await cache.delete(k);
}

self.addEventListener('fetch', (event) => {
	const req = event.request;
	if (req.method !== 'GET') return;
	const url = new URL(req.url);
	if (url.origin !== location.origin || skip(url)) return;

	// immutable build assets and static files: cache first
	if (build.includes(url.pathname) || files.includes(url.pathname)) {
		event.respondWith(caches.match(req).then((hit) => hit ?? fetch(req)));
		return;
	}

	// pages (HTML and SvelteKit data requests): network first, last ~50 visited stay readable offline
	const isPage = req.mode === 'navigate' || url.pathname.endsWith('/__data.json');
	if (isPage) {
		event.respondWith(
			fetch(req)
				.then((res) => {
					if (res.ok) event.waitUntil(put(PAGES, MAX_PAGES * 2, req, res.clone()));
					return res;
				})
				.catch(async () => (await caches.match(req)) ?? (await caches.match('/')) ?? Response.error())
		);
		return;
	}

	// attachments and cached diagrams: stale-while-revalidate
	event.respondWith(
		caches.match(req).then((hit) => {
			const net = fetch(req).then((res) => {
				if (res.ok) event.waitUntil(put(ASSETS, MAX_ASSETS, req, res.clone()));
				return res;
			});
			return hit ?? net;
		})
	);
});
