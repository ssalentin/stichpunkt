import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveCommit } from '../src/build-info';
import { CollectionStore } from '../src/lib/server/collections';
import { collectionsFile } from '../src/lib/server/collections-path';
import { loadConfig } from '../src/lib/server/config';

/**
 * `npm run export -- [dir]`
 *
 * Writes a full instance export (docs/export.md) into `dir`, default `./stichpunkt-export-<timestamp>`.
 * Needs no running server: it reads the same SPACE_DIR and COLLECTIONS_DB the service uses.
 * Read-only against the space and the collections database.
 */

const now = new Date();
const outDir = path.resolve(process.argv[2] ?? `stichpunkt-export-${now.toISOString().slice(0, 19).replaceAll(':', '').replaceAll('-', '')}`);

// tsx evaluates the sources without the Vite `define` that bakes the build identity in, so the
// globals must exist before `src/lib/version` runs; these are the same sources vite.config.ts uses.
(globalThis as Record<string, unknown>).__STICHPUNKT_VERSION__ ??= (
	JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;
(globalThis as Record<string, unknown>).__STICHPUNKT_COMMIT__ ??= resolveCommit(process.env.STICHPUNKT_COMMIT, () =>
	execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
);

const { buildInstanceExport, materializeInstanceExport } = await import('../src/lib/server/instance-export');

const config = loadConfig();
const store = CollectionStore.open(collectionsFile(config.spaceDir));
try {
	const bundle = await buildInstanceExport(store, config.spaceDir, now);
	materializeInstanceExport(bundle, outDir);
	console.info(`exported ${Object.keys(bundle.pages).length} page(s) and ${bundle.collections.length} collection(s) to ${outDir}`);
} catch (e) {
	console.error(`export failed: ${(e as Error).message}`);
	process.exitCode = 1;
} finally {
	store.close();
}
