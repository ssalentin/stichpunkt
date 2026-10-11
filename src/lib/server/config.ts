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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MdwikiConfig {
	return {
		spaceDir: path.resolve(env.SPACE_DIR || './space'),
		pollInterval: int(env.POLL_INTERVAL, 10_000),
		maxWriteBytes: int(env.MAX_WRITE_BYTES, 1024 * 1024),
		maxUploadBytes: int(env.MAX_UPLOAD_BYTES, 20 * 1024 * 1024)
	};
}
