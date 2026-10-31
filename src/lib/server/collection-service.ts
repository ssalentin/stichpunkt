import { loadConfig } from './config';
import { CollectionStore, collectionsFile } from './collections';

/**
 * Process-wide SQLite store. One writer per process is enough for SQLite (WAL + busy_timeout).
 * The path is derived from the configured space so content and data always live together.
 */
let store: CollectionStore | null = null;

export function getCollections(): CollectionStore {
	if (!store) {
		const config = loadConfig();
		store = CollectionStore.open(collectionsFile(config.spaceDir));
	}
	return store;
}

/** The store only when it is already open; live events must not create a database as a side effect. */
export function collectionsIfOpen(): CollectionStore | null {
	return store;
}

/** Tests and one-off scripts only. */
export function closeCollections(): void {
	store?.close();
	store = null;
}
