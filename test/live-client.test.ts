// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startLive } from '../src/lib/client/live';

/** Minimal EventSource: records instances and lets the test drive open/error/listeners. */
class FakeEventSource {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSED = 2;
	static instances: FakeEventSource[] = [];
	readyState = FakeEventSource.CONNECTING;
	onopen: (() => void) | null = null;
	onerror: (() => void) | null = null;
	closed = false;
	private listeners = new Map<string, Set<(event: { data: string }) => void>>();

	constructor(readonly url: string) {
		FakeEventSource.instances.push(this);
	}

	addEventListener(type: string, fn: (event: { data: string }) => void) {
		let set = this.listeners.get(type);
		if (!set) this.listeners.set(type, (set = new Set()));
		set.add(fn);
	}

	close() {
		this.closed = true;
		this.readyState = FakeEventSource.CLOSED;
	}

	open() {
		this.readyState = FakeEventSource.OPEN;
		this.onopen?.();
	}

	error(readyState: number) {
		this.readyState = readyState;
		this.onerror?.();
	}

	emit(type: string, data: string) {
		for (const fn of this.listeners.get(type) ?? []) fn({ data });
	}
}

function browser() {
	const listeners = new Map<string, Set<() => void>>();
	const document = {
		hidden: false,
		addEventListener(type: string, fn: () => void) {
			let set = listeners.get('document:' + type);
			if (!set) listeners.set('document:' + type, (set = new Set()));
			set.add(fn);
		},
		removeEventListener(type: string, fn: () => void) {
			listeners.get('document:' + type)?.delete(fn);
		}
	};
	const window = {
		addEventListener(type: string, fn: () => void) {
			let set = listeners.get('window:' + type);
			if (!set) listeners.set('window:' + type, (set = new Set()));
			set.add(fn);
		},
		removeEventListener(type: string, fn: () => void) {
			listeners.get('window:' + type)?.delete(fn);
		}
	};
	const fire = (target: 'document' | 'window', type: string) => {
		for (const fn of [...(listeners.get(`${target}:${type}`) ?? [])]) fn();
	};
	return { document, window, fire };
}

let env: ReturnType<typeof browser>;

beforeEach(() => {
	FakeEventSource.instances = [];
	env = browser();
	vi.stubGlobal('EventSource', FakeEventSource);
	vi.stubGlobal('document', env.document);
	vi.stubGlobal('window', env.window);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('live reconnect', () => {
	it('opens a fresh stream when the hidden tab becomes visible, even while CONNECTING', () => {
		const live = startLive({ onChange: () => {} });
		expect(FakeEventSource.instances).toHaveLength(1);
		expect(FakeEventSource.instances[0].readyState).toBe(FakeEventSource.CONNECTING);

		env.fire('document', 'visibilitychange');

		expect(FakeEventSource.instances).toHaveLength(2);
		expect(FakeEventSource.instances[0].closed).toBe(true);
		expect(FakeEventSource.instances[1].closed).toBe(false);
		live.stop();
	});

	it('does not reconnect while the tab is hidden', () => {
		const live = startLive({ onChange: () => {} });
		env.document.hidden = true;
		env.fire('document', 'visibilitychange');
		expect(FakeEventSource.instances).toHaveLength(1);
		live.stop();
	});

	it('retry() reconnects immediately, independent of any pending timer', () => {
		const live = startLive({ onChange: () => {} });
		live.retry();
		expect(FakeEventSource.instances).toHaveLength(2);
		expect(FakeEventSource.instances[0].closed).toBe(true);
		expect(FakeEventSource.instances[1].closed).toBe(false);
		live.stop();
	});

	it('reconnects on the online event and stops after stop()', () => {
		const live = startLive({ onChange: () => {} });
		env.fire('window', 'online');
		expect(FakeEventSource.instances).toHaveLength(2);
		live.stop();
		live.retry();
		env.fire('document', 'visibilitychange');
		expect(FakeEventSource.instances).toHaveLength(2);
	});

	it('reports connected and disconnected status', () => {
		const status: boolean[] = [];
		const live = startLive({ onChange: () => {}, onStatus: (on) => status.push(on) });
		FakeEventSource.instances[0].open();
		FakeEventSource.instances[0].error(FakeEventSource.CONNECTING);
		expect(status).toEqual([true, false]);
		live.stop();
	});

	it('delivers changes held while hidden after reconnecting', () => {
		const seen: (string[] | null)[] = [];
		const live = startLive({ onChange: (paths) => seen.push(paths) });
		const source = FakeEventSource.instances[0];
		env.document.hidden = true;
		source.emit('change', JSON.stringify({ boot: 'b', version: 1, paths: ['Notes/A'] }));
		expect(seen).toEqual([]);
		env.document.hidden = false;
		env.fire('document', 'visibilitychange');
		expect(seen).toEqual([['Notes/A']]);
		live.stop();
	});
});
