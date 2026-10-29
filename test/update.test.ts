// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dismissUpdate, runningBuild, update, UPDATE_DISMISSED_KEY, watchForUpdates } from '../src/lib/client/update.svelte';

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

beforeEach(() => {
	worker = new FakeWorker();
	vi.stubGlobal('navigator', { serviceWorker: worker });
	update.available = false;
	update.dismissed = true;
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
		clear: () => map.clear()
	};
}

describe('update banner', () => {
	it('ignores the first install and shows the banner on the next takeover', () => {
		// first visit: the page was loaded before any service worker existed
		worker.controller = null;
		const off = watchForUpdates();
		worker.change();
		expect(update.available).toBe(false);
		worker.change();
		expect(update.available).toBe(true);
		expect(update.dismissed).toBe(false);
		off();
	});

	it('shows the banner right away when a worker already controls the page', () => {
		worker.controller = {};
		const off = watchForUpdates();
		worker.change();
		expect(update.available).toBe(true);
		off();
	});

	it('stops listening after the cleanup', () => {
		worker.controller = {};
		const off = watchForUpdates();
		off();
		worker.change();
		expect(update.available).toBe(false);
	});

	it('keeps the hint dismissed for the running build and survives further changes', () => {
		const store = fakeStorage();
		vi.stubGlobal('localStorage', store);
		worker.controller = {};
		const off = watchForUpdates();
		worker.change();
		expect(update.available).toBe(true);

		dismissUpdate();
		expect(store.getItem(UPDATE_DISMISSED_KEY)).toBe(runningBuild());

		worker.change();
		expect(update.dismissed).toBe(true);
		expect(update.available && !update.dismissed).toBe(false);
		off();
	});

	it('reads a stored dismissal for the same build and stays quiet', () => {
		const store = fakeStorage();
		store.setItem(UPDATE_DISMISSED_KEY, runningBuild());
		vi.stubGlobal('localStorage', store);
		worker.controller = {};
		const off = watchForUpdates();
		expect(update.dismissed).toBe(true);
		worker.change();
		expect(update.available).toBe(false);
		off();
	});

	it('ignores a dismissal from an older build and announces the next one', () => {
		const store = fakeStorage();
		store.setItem(UPDATE_DISMISSED_KEY, '0.0.0+oldbuild');
		vi.stubGlobal('localStorage', store);
		worker.controller = {};
		const off = watchForUpdates();
		expect(update.dismissed).toBe(false);
		worker.change();
		expect(update.available).toBe(true);
		off();
	});

	it('does not throw when localStorage is missing or blocked', () => {
		const off = watchForUpdates();
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
	});

	it('does nothing without a service worker', () => {
		vi.unstubAllGlobals();
		vi.stubGlobal('navigator', {});
		expect(() => watchForUpdates()()).not.toThrow();
		expect(update.available).toBe(false);
	});
});
