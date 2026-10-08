import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { FolioError } from './errors';
import { assertAllowedExtension, resolveInside } from './paths';

export interface Limits {
	maxWriteBytes: number;
	maxUploadBytes: number;
}

export interface FileInfo {
	rel: string;
	mtimeMs: number;
	size: number;
}

export function hashOf(data: Buffer | string): string {
	return createHash('sha256').update(data).digest('hex');
}

/** Plain directory of files. All access goes through safe path resolution. */
export class Store {
	private locks = new Map<string, Promise<unknown>>();

	constructor(
		readonly root: string,
		readonly limits: Limits
	) {}

	/** Serialises read-modify-write cycles per file inside this process. */
	async withLock<T>(rel: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.locks.get(rel) ?? Promise.resolve();
		const run = prev.then(fn, fn);
		const tail = run.catch(() => undefined);
		this.locks.set(rel, tail);
		try {
			return await run;
		} finally {
			if (this.locks.get(rel) === tail) this.locks.delete(rel);
		}
	}

	async stat(rel: string): Promise<FileInfo | null> {
		const abs = await resolveInside(this.root, rel);
		try {
			const st = await fs.stat(abs);
			if (!st.isFile()) return null;
			return { rel, mtimeMs: st.mtimeMs, size: st.size };
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw e;
		}
	}

	async read(rel: string): Promise<{ data: Buffer; info: FileInfo } | null> {
		assertAllowedExtension(rel);
		const abs = await resolveInside(this.root, rel);
		try {
			const [data, st] = await Promise.all([fs.readFile(abs), fs.stat(abs)]);
			return { data, info: { rel, mtimeMs: st.mtimeMs, size: st.size } };
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code === 'ENOENT' || code === 'EISDIR') return null;
			throw e;
		}
	}

	/** Atomic write (temp file + rename). Caller holds the lock if it needs read-modify-write. */
	async write(rel: string, data: Buffer, kind: 'page' | 'upload'): Promise<FileInfo> {
		assertAllowedExtension(rel);
		const limit = kind === 'page' ? this.limits.maxWriteBytes : this.limits.maxUploadBytes;
		if (data.length > limit) {
			throw new FolioError(413, 'too_large', `Write exceeds the limit of ${limit} bytes`);
		}
		const abs = await resolveInside(this.root, rel);
		await fs.mkdir(path.dirname(abs), { recursive: true });
		// re-check after mkdir so freshly created directories are covered as well
		await resolveInside(this.root, rel);
		const tmp = path.join(path.dirname(abs), `.folio-${randomBytes(6).toString('hex')}.tmp`);
		try {
			await fs.writeFile(tmp, data, { flag: 'wx', mode: 0o644 });
			await fs.rename(tmp, abs);
		} catch (e) {
			await fs.rm(tmp, { force: true });
			throw e;
		}
		const st = await fs.stat(abs);
		return { rel, mtimeMs: st.mtimeMs, size: st.size };
	}

	async remove(rel: string): Promise<boolean> {
		assertAllowedExtension(rel);
		const abs = await resolveInside(this.root, rel);
		try {
			await fs.unlink(abs);
			return true;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
			throw e;
		}
	}

	/** Lists markdown files, skipping dot entries and anything that resolves outside the root. */
	async scan(): Promise<FileInfo[]> {
		const realRoot = await fs.realpath(this.root);
		const out: FileInfo[] = [];
		const walk = async (dir: string, rel: string) => {
			let entries;
			try {
				entries = await fs.readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const ent of entries) {
				if (ent.name.startsWith('.')) continue;
				const childRel = rel ? `${rel}/${ent.name}` : ent.name;
				const abs = path.join(dir, ent.name);
				try {
					if (ent.isSymbolicLink()) {
						const real = await fs.realpath(abs);
						if (real !== realRoot && !real.startsWith(realRoot + path.sep)) continue;
					}
					const st = await fs.stat(abs);
					if (st.isDirectory()) await walk(abs, childRel);
					else if (st.isFile() && /\.md$/i.test(ent.name)) {
						out.push({ rel: childRel.normalize('NFC'), mtimeMs: st.mtimeMs, size: st.size });
					}
				} catch {
					// vanished or unreadable entry: ignore, the next poll sees the final state
				}
			}
		};
		await walk(realRoot, '');
		return out;
	}
}
