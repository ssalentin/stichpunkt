import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/lib/server/config';
import { Folio } from '../src/lib/server/service';

export const FIXTURES = path.resolve(__dirname, 'fixtures/space');

/** Copies the synthetic space into a fresh temp dir so tests may write freely. */
export function tempSpace(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-space-'));
	fs.cpSync(FIXTURES, dir, { recursive: true });
	return dir;
}

export async function makeFolio(opts: { poll?: number; env?: Record<string, string> } = {}) {
	const dir = tempSpace();
	const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-cache-'));
	const config = loadConfig({
		SPACE_DIR: dir,
		CACHE_DIR: cache,
		FOLIO_API_TOKEN: 'test-token',
		KROKI_URL: '',
		POLL_INTERVAL: String(opts.poll ?? 10_000),
		...opts.env
	} as NodeJS.ProcessEnv);
	const folio = await new Folio(config).start(opts.poll !== undefined);
	return { folio, dir, cache };
}
