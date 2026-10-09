import { createHash, timingSafeEqual } from 'node:crypto';

/** /api and /mcp (any depth, any case, any encoding) require the bearer token. */
export function isProtectedPath(pathname: string): boolean {
	let p = pathname;
	try {
		for (let i = 0; i < 3 && /%/.test(p); i++) p = decodeURIComponent(p);
	} catch {
		return true; // undecodable paths are never worth a guess: fail closed
	}
	p = p.replace(/[\\/]+/g, '/').toLowerCase();
	return /^\/(api|mcp)(\/|$)/.test(p);
}

/** Constant-time comparison of the presented bearer token with the configured one. */
export function checkBearer(header: string | null, token: string): boolean {
	if (!token || !header) return false;
	const m = /^Bearer[ ]+(.+)$/i.exec(header.trim());
	if (!m) return false;
	const a = createHash('sha256').update(m[1].trim()).digest();
	const b = createHash('sha256').update(token).digest();
	return timingSafeEqual(a, b);
}
