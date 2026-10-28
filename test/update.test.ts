// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { update, watchForUpdates } from '../src/lib/client/update.svelte';

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

	it('does nothing without a service worker', () => {
		vi.unstubAllGlobals();
		vi.stubGlobal('navigator', {});
		expect(() => watchForUpdates()()).not.toThrow();
		expect(update.available).toBe(false);
	});
});
