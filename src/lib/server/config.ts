import { readdirSync } from 'node:fs';
import path from 'node:path';

export interface MdwikiConfig {
	spaceDir: string;
	pollInterval: number;
	maxWriteBytes: number;
	maxUploadBytes: number;
}

function int(value: string | undefined, fallback: number): number {
	const n = Number.parseInt(value ?? '', 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nonEmptyDir(dir: string): boolean {
	try {
		return readdirSync(dir).length > 0;
	} catch {
		return false;
	}
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MdwikiConfig {
	const configuredSpace = path.resolve(env.SPACE_DIR || './space');
	const fallbackSpace = env.SPACE_FALLBACK_DIR ? path.resolve(env.SPACE_FALLBACK_DIR) : '';
	return {
		spaceDir: !nonEmptyDir(configuredSpace) && nonEmptyDir(fallbackSpace) ? fallbackSpace : configuredSpace,
		pollInterval: int(env.POLL_INTERVAL, 10_000),
		maxWriteBytes: int(env.MAX_WRITE_BYTES, 1024 * 1024),
		maxUploadBytes: int(env.MAX_UPLOAD_BYTES, 20 * 1024 * 1024)
	};
}
