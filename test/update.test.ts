// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkForUpdate, dismissUpdate, runningBuild, update, UPDATE_DISMISSED_KEY, watchForUpdates } from '../src/lib/client/update.svelte';

/** Minimal ServiceWorkerContainer: tracks controllerchange listeners and can fire them. */
class FakeWorker {
	controller: unknown = null;
	private listeners = new Set<() => void>();

	addEventListener(type: string, fn: () => void) {
		if (type === 'controllerchange') this.listeners.add(fn);
	}

	removeEventListener(type: string, fn: () => void) {
		if (type === 'controllerchange') this.listeners.delete(fn);
	}

	change() {
		for (const fn of [...this.listeners]) fn();
	}
}

let worker: FakeWorker;

/** Resolve the pending update check (it is started without await). */
const flush = () => new Promise((r) => setTimeout(r, 0));

function stubBuild(build: string) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(JSON.stringify({ build }), { status: 200, headers: { 'content-type': 'application/json' } }))
	);
}

beforeEach(() => {
	worker = new FakeWorker();
	vi.stubGlobal('navigator', { serviceWorker: worker });
	update.available = false;
	update.dismissed = false;
	stubBuild(runningBuild());
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function fakeStorage() {
	const map = new Map<string, string>();
	return {
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => void map.set(key, value),
		removeItem: (key: string) => void map.delete(key),
		clear: () => void map.clear()
	};
}

describe('update banner', () => {
	it('stays quiet when the page already runs the build the server serves', async () => {
		const off = watchForUpdates();
		await flush();
		expect(update.available).toBe(false);
		off();
	});

	it('shows the banner when the server runs a different build', async () => {
		stubBuild('0.0.0+newbuild');
		const off = watchForUpdates();
		await flush();
		expect(update.available).toBe(true);
		expect(update.dismissed).toBe(false);
		off();
	});

	it('clears the banner when the same check runs on the new build after a reload', async () => {
		update.available = true;
		stubBuild(runningBuild());
		await checkForUpdate();
		expect(update.available).toBe(false);
	});

	it('re-checks when a service worker takes over', async () => {
		const off = watchForUpdates();
		await flush();
		expect(update.available).toBe(false);

		stubBuild('0.0.0+newbuild');
		worker.change();
		await flush();
		expect(update.available).toBe(true);
		off();
	});

	it('stops listening after the cleanup', async () => {
		const off = watchForUpdates();
		off();
		stubBuild('0.0.0+newbuild');
		worker.change();
		await flush();
		expect(update.available).toBe(false);
	});

	it('keeps the hint dismissed for the running build', async () => {
		const store = fakeStorage();
		vi.stubGlobal('localStorage', store);
		stubBuild('0.0.0+newbuild');
		const off = watchForUpdates();
		await flush();
		expect(update.available).toBe(true);

		dismissUpdate();
		expect(store.getItem(UPDATE_DISMISSED_KEY)).toBe(runningBuild());
		expect(update.available).toBe(false);

		await checkForUpdate();
		expect(update.available).toBe(false);
		off();
	});

	it('reads a stored dismissal for the same build and stays quiet', async () => {
		const store = fakeStorage();
		store.setItem(UPDATE_DISMISSED_KEY, runningBuild());
		vi.stubGlobal('localStorage', store);
		stubBuild('0.0.0+newbuild');
		const off = watchForUpdates();
		await flush();
		expect(update.dismissed).toBe(true);
		expect(update.available).toBe(false);
		off();
	});

	it('keeps the previous state when the check fails', async () => {
		update.available = true;
		vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));
		await checkForUpdate();
		expect(update.available).toBe(true);
	});

	it('does not throw when localStorage is missing or blocked', async () => {
		const off = watchForUpdates();
		await flush();
		expect(() => dismissUpdate()).not.toThrow();
		off();
		vi.stubGlobal('localStorage', {
			getItem: () => {
				throw new Error('blocked');
			},
			setItem: () => {
				throw new Error('blocked');
			}
		});
		expect(() => watchForUpdates()).not.toThrow();
		expect(() => dismissUpdate()).not.toThrow();
		await flush();
	});

	it('does nothing without a service worker', async () => {
		vi.unstubAllGlobals();
		vi.stubGlobal('navigator', {});
		expect(() => watchForUpdates()()).not.toThrow();
		expect(update.available).toBe(false);
	});
});
