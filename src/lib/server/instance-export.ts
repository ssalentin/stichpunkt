import fs from 'node:fs';
import path from 'node:path';
import { APP_VERSION } from '../version';
import type { CollectionStore } from './collections';
import { exportCollection, exportFilename, readAllRows, toCsv, type CollectionExport } from './collections-export';
import { Store } from './store';

/**
 * Whole-instance export: every page plus every collection in one versioned bundle.
 *
 * A single collection export is portable but not a backup: a restore needs the pages as well, and
 * a reviewer needs one header that says which format and which build produced the set. The bundle
 * keeps the JSON per collection canonical (it is what a restore reads) and adds CSV as the
 * spreadsheet view of the same rows. Everything is read-only against the store and the space.
 */

export const INSTANCE_EXPORT_VERSION = 1;

export interface InstanceExport {
	format: 'stichpunkt-export';
	version: number;
	exported_at: string;
	app_version: string;
	/** page file path relative to the space root (no leading slash) -> full content */
	pages: Record<string, string>;
	collections: Array<CollectionExport & { csv: string }>;
}

export async function buildInstanceExport(store: CollectionStore, spaceDir: string, now = new Date()): Promise<InstanceExport> {
	// read-only pass; the write limits are never consulted by `scan` and `read`
	const files = new Store(spaceDir, { maxWriteBytes: Number.POSITIVE_INFINITY, maxUploadBytes: Number.POSITIVE_INFINITY });
	const pages: Record<string, string> = {};
	for (const info of await files.scan()) {
		const file = await files.read(info.rel);
		if (file) pages[info.rel] = file.data.toString('utf8');
	}
	const collections = store.list().map((collection) => ({
		...exportCollection(store, collection.id, now),
		csv: toCsv(collection.properties, readAllRows(store, collection.id))
	}));
	return { format: 'stichpunkt-export', version: INSTANCE_EXPORT_VERSION, exported_at: now.toISOString(), app_version: APP_VERSION, pages, collections };
}

/**
 * Materialises the bundle into `dir` (created if missing):
 * `export.json` header, `pages/<relPath>` byte-identical to the space, and per collection
 * `collections/<name>.json` (the importable snapshot without the CSV field) plus `.csv`.
 */
export function materializeInstanceExport(bundle: InstanceExport, dir: string): void {
	fs.mkdirSync(path.join(dir, 'pages'), { recursive: true });
	fs.mkdirSync(path.join(dir, 'collections'), { recursive: true });
	const header = {
		format: bundle.format,
		version: bundle.version,
		exported_at: bundle.exported_at,
		app_version: bundle.app_version,
		pages: Object.keys(bundle.pages).length,
		collections: bundle.collections.length
	};
	fs.writeFileSync(path.join(dir, 'export.json'), JSON.stringify(header, null, 2) + '\n');
	for (const [rel, content] of Object.entries(bundle.pages)) {
		const target = path.join(dir, 'pages', rel);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	}
	for (const entry of bundle.collections) {
		const jsonName = exportFilename(entry.collection.name, 'json').ascii;
		const csvName = exportFilename(entry.collection.name, 'csv').ascii;
		const { csv, ...json } = entry;
		void csv;
		fs.writeFileSync(path.join(dir, 'collections', jsonName), JSON.stringify(json, null, 2) + '\n');
		fs.writeFileSync(path.join(dir, 'collections', csvName), entry.csv);
	}
}
