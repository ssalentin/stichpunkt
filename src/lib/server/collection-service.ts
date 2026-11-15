import { loadConfig } from './config';
import { CollectionStore, collectionsFile } from './collections';

/**
 * Process-wide SQLite store. One writer per process is enough for SQLite (WAL + busy_timeout).
 * The path is derived from the configured space so content and data always live together.
 */
let store: CollectionStore | null = null;
/** callbacks registered while the store was closed; run on the first open below */
const waiters: ((store: CollectionStore) => void)[] = [];

export function getCollections(): CollectionStore {
	if (!store) {
		const config = loadConfig();
		store = CollectionStore.open(collectionsFile(config.spaceDir));
		for (const fn of waiters.splice(0)) fn(store);
	}
	return store;
}

/**
 * Runs `fn` with the store once it is open — immediately if it already is, otherwise when the
 * first `getCollections()` opens it. Never opens the store itself, so observing live events
 * cannot create a database as a side effect. Returns the unregister function.
 */
export function whenCollectionsOpen(fn: (store: CollectionStore) => void): () => void {
	if (store) {
		fn(store);
		return () => {};
	}
	waiters.push(fn);
	return () => {
		const at = waiters.indexOf(fn);
		if (at >= 0) waiters.splice(at, 1);
	};
}

/** The store only when it is already open; live events must not create a database as a side effect. */
export function collectionsIfOpen(): CollectionStore | null {
	return store;
}

/** Tests and one-off scripts only. */
export function closeCollections(): void {
	store?.close();
	store = null;
	waiters.length = 0;
}
