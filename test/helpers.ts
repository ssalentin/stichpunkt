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
	// The boot-time row indexer (issue #84) opens `COLLECTIONS_DB` when the file already exists.
	// Pin that seam to the temp space, so a test can never open or index the live collections database.
	process.env.COLLECTIONS_DB = opts.env?.COLLECTIONS_DB ?? path.join(dir, 'collections.sqlite');
	const config = loadConfig({
		SPACE_DIR: dir,
		MDWIKI_API_TOKEN: 'test-token',
		POLL_INTERVAL: String(opts.poll ?? 10_000),
		...opts.env
	} as NodeJS.ProcessEnv);
	const mdwiki = await new Mdwiki(config).start(opts.poll !== undefined);
	return { mdwiki, dir };
}
