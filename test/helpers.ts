import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/lib/server/config';
import { Mdwiki } from '../src/lib/server/service';

export const FIXTURES = path.resolve(__dirname, 'fixtures/space');

/** Copies the synthetic space into a fresh temp dir so tests may write freely. */
export function tempSpace(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdwiki-space-'));
	fs.cpSync(FIXTURES, dir, { recursive: true });
	return dir;
}

export async function makeMdwiki(opts: { poll?: number; env?: Record<string, string> } = {}) {
	const dir = tempSpace();
	const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'mdwiki-cache-'));
	const config = loadConfig({
		SPACE_DIR: dir,
		CACHE_DIR: cache,
		MDWIKI_API_TOKEN: 'test-token',
		KROKI_URL: '',
		POLL_INTERVAL: String(opts.poll ?? 10_000),
		...opts.env
	} as NodeJS.ProcessEnv);
	const mdwiki = await new Mdwiki(config).start(opts.poll !== undefined);
	return { mdwiki, dir, cache };
}
