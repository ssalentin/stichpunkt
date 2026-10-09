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

export const MIN_TOKEN_LENGTH = 32;
const PLACEHOLDER_TOKEN = 'change-me';
let warnedWeak = false;

/**
 * The bearer token from the environment, or '' (every protected request gets 401) when it is
 * shorter than MIN_TOKEN_LENGTH or the shipped placeholder. The single place that decides this.
 */
export function configuredToken(raw: string | undefined = process.env.MDWIKI_API_TOKEN): string {
	const token = raw ?? '';
	if (!token) return '';
	if (token.length < MIN_TOKEN_LENGTH || token === PLACEHOLDER_TOKEN) {
		if (!warnedWeak) {
			warnedWeak = true;
			console.error(
				`MDWIKI_API_TOKEN rejected: it must be at least ${MIN_TOKEN_LENGTH} characters and not the placeholder. ` +
					'/mcp and /api answer 401 until it is replaced (openssl rand -base64 32).'
			);
		}
		return '';
	}
	return token;
}
