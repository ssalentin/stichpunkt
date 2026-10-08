import fs from 'node:fs/promises';
import path from 'node:path';
import { FolioError } from './errors';

/** Extensions that may be read, written or uploaded. Everything else is rejected. */
export const ALLOWED_EXTENSIONS = new Set([
	'md',
	'txt',
	'csv',
	'json',
	'pdf',
	'png',
	'jpg',
	'jpeg',
	'gif',
	'webp',
	'avif',
	'heic',
	'svg'
]);

const MAX_PATH_LENGTH = 512;

/**
 * Validates a user supplied relative path (page name or file path) and returns its
 * normalised form. Purely lexical; symlinks are handled by `resolveInside`.
 */
export function normalizeRel(input: unknown): string {
	if (typeof input !== 'string' || input.length === 0) {
		throw new FolioError(400, 'bad_path', 'Path must be a non-empty string');
	}
	if (input.length > MAX_PATH_LENGTH) throw new FolioError(400, 'bad_path', 'Path too long');
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f\\]/.test(input)) {
		throw new FolioError(400, 'bad_path', 'Path contains control characters or backslashes');
	}
	if (input.startsWith('/') || /^[A-Za-z]:/.test(input)) {
		throw new FolioError(400, 'bad_path', 'Absolute paths are not allowed');
	}
	const rel = input.normalize('NFC');
	const segments = rel.split('/');
	for (const seg of segments) {
		if (seg === '' || seg === '.' || seg === '..') {
			throw new FolioError(400, 'bad_path', 'Path must not contain empty, "." or ".." segments');
		}
		if (seg.startsWith('.')) {
			throw new FolioError(400, 'bad_path', 'Hidden files and folders are not allowed');
		}
		if (/[. ]$/.test(seg)) {
			throw new FolioError(400, 'bad_path', 'Path segments must not end with a dot or space');
		}
	}
	return segments.join('/');
}

export function extOf(rel: string): string {
	const base = rel.slice(rel.lastIndexOf('/') + 1);
	const i = base.lastIndexOf('.');
	return i <= 0 ? '' : base.slice(i + 1).toLowerCase();
}

export function assertAllowedExtension(rel: string): string {
	const ext = extOf(rel);
	if (!ALLOWED_EXTENSIONS.has(ext)) {
		throw new FolioError(400, 'bad_extension', `File type ".${ext}" is not allowed`);
	}
	return ext;
}

/** Page name -> file path relative to the space. Accepts a trailing ".md". */
export function pageToFile(page: string): string {
	const name = normalizeRel(page.replace(/\.md$/i, ''));
	return `${name}.md`;
}

export function fileToPage(rel: string): string {
	return rel.replace(/\.md$/i, '');
}

function isInside(root: string, target: string): boolean {
	return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * Resolves `rel` below `root` and verifies, using real paths, that neither the target nor
 * its deepest existing ancestor escapes the root through a symlink.
 */
export async function resolveInside(root: string, rel: string): Promise<string> {
	const realRoot = await fs.realpath(root);
	const abs = path.join(realRoot, rel);
	if (!isInside(realRoot, abs)) throw new FolioError(400, 'bad_path', 'Path escapes the space');
	let probe = abs;
	for (;;) {
		try {
			const real = await fs.realpath(probe);
			if (!isInside(realRoot, real)) {
				throw new FolioError(400, 'bad_path', 'Path escapes the space through a symlink');
			}
			break;
		} catch (e) {
			if (e instanceof FolioError) throw e;
			const code = (e as NodeJS.ErrnoException).code;
			if (code === 'ENOENT' || code === 'ENOTDIR') {
				// realpath fails for dangling symlinks too; those must not be written through
				const link = await fs.lstat(probe).catch(() => null);
				if (link) throw new FolioError(400, 'bad_path', 'Dangling symlink');
				const parent = path.dirname(probe);
				if (parent === probe) throw new FolioError(400, 'bad_path', 'Invalid path');
				probe = parent;
				continue;
			}
			// ELOOP and friends: a broken or circular symlink is never acceptable
			throw new FolioError(400, 'bad_path', 'Path cannot be resolved');
		}
	}
	return abs;
}
