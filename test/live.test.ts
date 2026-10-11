import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLive } from '../src/lib/client/live';
import type { SpaceChange } from '../src/lib/server/space';
import { makeMdwiki } from './helpers';

describe('index change events', () => {
	it('announces API writes and deletes with the page path', async () => {
		const { mdwiki } = await makeMdwiki();
		const seen: SpaceChange[] = [];
		const off = mdwiki.index.subscribe((c) => seen.push(c));
		await mdwiki.writePage('Live/One', '# One');
		await mdwiki.writePage('Live/One', '# One\n\nmore');
		await mdwiki.deletePage('Live/One');
		off();
		await mdwiki.writePage('Live/Two', 'ignored after unsubscribe');
		expect(seen.map((c) => c.paths)).toEqual([['Live/One'], ['Live/One'], ['Live/One']]);
		expect(seen[2].version).toBeGreaterThan(seen[0].version);
	});

	it('announces edits made on disk once the poll finds them', async () => {
		const { mdwiki, dir } = await makeMdwiki();
		const seen: string[][] = [];
		mdwiki.index.subscribe((c) => seen.push(c.paths));
		expect(await mdwiki.index.refresh()).toBe(false);
		expect(seen).toEqual([]);
		fs.writeFileSync(path.join(dir, 'FromDisk.md'), '# Disk');
		fs.rmSync(path.join(dir, 'Syntax.md'));
		await mdwiki.index.refresh();
		expect(seen).toHaveLength(1);
		expect(seen[0].sort()).toEqual(['FromDisk', 'Syntax']);
	});

	it('survives a throwing listener', async () => {
		const { mdwiki } = await makeMdwiki();
		const seen: string[][] = [];
		mdwiki.index.subscribe(() => {
			throw new Error('boom');
		});
		mdwiki.index.subscribe((c) => seen.push(c.paths));
		await mdwiki.writePage('X', 'x');
		expect(seen).toEqual([['X']]);
	});
});

describe('GET /_ui/events', () => {
	let route: typeof import('../src/routes/_ui/events/+server');
	let svc: Awaited<ReturnType<typeof import('../src/lib/server/service')['getMdwiki']>>;

	beforeAll(async () => {
		const { dir, cache, mdwiki } = await makeMdwiki();
		mdwiki.stop();
		process.env.SPACE_DIR = dir;
		process.env.CACHE_DIR = cache;
		process.env.KROKI_URL = '';
		process.env.MDWIKI_API_TOKEN = 'test-token-0123456789-0123456789-abcdef';
		route = await import('../src/routes/_ui/events/+server');
		svc = await (await import('../src/lib/server/service')).getMdwiki();
	});
	afterAll(() => svc.stop());

	async function read(reader: ReadableStreamDefaultReader<Uint8Array>, until: RegExp) {
		const dec = new TextDecoder();
		let text = '';
		for (let i = 0; i < 20 && !until.test(text); i++) text += dec.decode((await reader.read()).value);
		return text;
	}

	it('streams hello, then one coalesced change per burst of writes', async () => {
		const ac = new AbortController();
		const res = await route.GET({ request: new Request('http://localhost/_ui/events', { signal: ac.signal }) } as never);
		expect(res.headers.get('content-type')).toContain('text/event-stream');
		expect(res.headers.get('cache-control')).toContain('no-store');
		const reader = res.body!.getReader();
		const first = await read(reader, /event: hello/);
		expect(first).toMatch(/event: hello\ndata: \{"boot":"[^"]+","version":\d+\}/);

		await svc.writePage('Burst/A', 'a');
		await svc.writePage('Burst/B', 'b');
		const next = await read(reader, /event: change/);
		const data = JSON.parse(/event: change\ndata: (.*)\n/.exec(next)![1]);
		expect(data.paths.sort()).toEqual(['Burst/A', 'Burst/B']);
		ac.abort();
	});

	it('stops listening when the client goes away', async () => {
		const ac = new AbortController();
		const res = await route.GET({ request: new Request('http://localhost/_ui/events', { signal: ac.signal }) } as never);
		await res.body!.getReader().read();
		const listeners = (svc.index as unknown as { listeners: Set<unknown> }).listeners;
		const during = listeners.size;
		ac.abort();
		expect(listeners.size).toBe(during - 1);
	});
});

describe('startLive (client)', () => {
	class FakeSource {
		static all: FakeSource[] = [];
		handlers: Record<string, (e: { data: string }) => void> = {};
		onopen: (() => void) | null = null;
		onerror: (() => void) | null = null;
		closed = false;
		constructor(readonly url: string) {
			FakeSource.all.push(this);
		}
		addEventListener(name: string, fn: (e: { data: string }) => void) {
			this.handlers[name] = fn;
		}
		emit(name: string, data: unknown) {
			this.handlers[name]({ data: JSON.stringify(data) });
		}
		close() {
			this.closed = true;
		}
	}
	const doc = { hidden: false, listeners: new Map<string, () => void>(), addEventListener(n: string, f: () => void) { this.listeners.set(n, f); }, removeEventListener(n: string) { this.listeners.delete(n); } };

	const setup = () => {
		FakeSource.all = [];
		doc.hidden = false;
		Object.assign(globalThis, { EventSource: FakeSource, document: doc });
		const calls: (string[] | null)[] = [];
		const status: boolean[] = [];
		const stop = startLive({ onChange: (p) => calls.push(p), onStatus: (s) => status.push(s) });
		return { es: FakeSource.all[0], calls, status, stop };
	};

	it('delivers changes and reports the connection state', () => {
		const { es, calls, status, stop } = setup();
		es.onopen!();
		es.emit('hello', { boot: 'b', version: 1 });
		es.emit('change', { boot: 'b', version: 2, paths: ['A'] });
		es.onerror!();
		expect(calls).toEqual([['A']]);
		expect(status).toEqual([true, false]);
		stop();
		expect(es.closed).toBe(true);
	});

	it('treats a reconnect that finds a newer version, or a new server, as possibly missed changes', () => {
		const { es, calls } = setup();
		es.emit('hello', { boot: 'b', version: 1 });
		es.emit('hello', { boot: 'b', version: 1 }); // plain reconnect: nothing missed
		es.emit('hello', { boot: 'b', version: 5 });
		es.emit('hello', { boot: 'other', version: 5 });
		expect(calls).toEqual([null, null]);
	});

	it('holds changes while the tab is hidden and delivers them once on return', () => {
		const { es, calls } = setup();
		doc.hidden = true;
		es.emit('change', { boot: 'b', version: 2, paths: ['A'] });
		es.emit('change', { boot: 'b', version: 3, paths: ['B', 'A'] });
		expect(calls).toEqual([]);
		doc.hidden = false;
		doc.listeners.get('visibilitychange')!();
		doc.listeners.get('visibilitychange')!();
		expect(calls).toEqual([['A', 'B']]);
	});
});
