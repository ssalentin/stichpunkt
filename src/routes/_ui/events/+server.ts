import { randomUUID } from 'node:crypto';
import { collectionsIfOpen } from '#lib/server/collection-service';
import { getMdwiki } from '#lib/server/service';
import type { RequestHandler } from './$types';

/** Identifies this server process, so a client can tell a restart from a plain reconnect. */
const BOOT = randomUUID();
const HEARTBEAT_MS = 25_000;
/** Changes inside this window are sent as one event (an agent writing several pages in a row). */
const COALESCE_MS = 250;
const MAX_PATHS = 200;
const MAX_CLIENTS = 200;
let clients = 0;

/**
 * Server-sent events for live reload. The stream is read only and carries no page content, only
 * which pages changed; the client then reloads its own data through the normal (cached, authorised)
 * page requests. `hello` opens every connection with the current version, `change` follows each
 * (coalesced) change, and a comment line every 25 s keeps proxies from closing an idle stream.
 */
export const GET: RequestHandler = async ({ request }) => {
	if (clients >= MAX_CLIENTS) return new Response('Too many live connections', { status: 503, headers: { 'retry-after': '30' } });
	const { index } = await getMdwiki();
	const enc = new TextEncoder();
	let cleanup = () => {};

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			clients++;
			const send = (chunk: string) => {
				try {
					controller.enqueue(enc.encode(chunk));
				} catch {
					cleanup();
				}
			};
			const event = (name: string, data: unknown) => send(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);

			let pending = new Set<string>();
			let timer: ReturnType<typeof setTimeout> | null = null;
			const flush = () => {
				timer = null;
				const paths = [...pending].slice(0, MAX_PATHS);
				pending = new Set();
				event('change', { boot: BOOT, version: index.version, paths });
			};
			const unsubscribe = index.subscribe((c) => {
				for (const p of c.paths) pending.add(p);
				timer ??= setTimeout(flush, COALESCE_MS);
			});
			// collections share this stream; their store is only observed when the UI already opened it,
			// so opening a page never creates a database as a side effect
			const unsubscribeCollections =
				collectionsIfOpen()?.subscribe((id) => {
					pending.add(`__db__/${id}`);
					timer ??= setTimeout(flush, COALESCE_MS);
				}) ?? (() => {});
			const heartbeat = setInterval(() => send(': keep-alive\n\n'), HEARTBEAT_MS);

			let closed = false;
			cleanup = () => {
				if (closed) return;
				closed = true;
				clients--;
				unsubscribe();
				unsubscribeCollections();
				clearInterval(heartbeat);
				if (timer) clearTimeout(timer);
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			};
			request.signal.addEventListener('abort', cleanup);
			send('retry: 3000\n\n');
			event('hello', { boot: BOOT, version: index.version });
		},
		cancel() {
			cleanup();
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-store, no-transform',
			'x-accel-buffering': 'no'
		}
	});
};
