import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSP_DIRECTIVES } from '../src/csp';
import { makeMdwiki } from './helpers';

// SvelteKit's Csp runtime reads this build-time global; the framework normally replaces it.
(globalThis as Record<string, unknown>).__SVELTEKIT_DEV__ = false;

const README = path.resolve(__dirname, '..');

/**
 * The directives wired into `kit.csp` are the single source of truth. Assert that
 * vite.config.ts actually feeds them to SvelteKit in `auto` mode, rather than
 * trusting a copy.
 */
describe('content security policy wiring', () => {
	const config = fs.readFileSync(path.join(README, 'vite.config.ts'), 'utf8');

	it('passes the shared directives to kit.csp with mode auto', () => {
		expect(config).toContain('csp:');
		expect(config).toMatch(/mode:\s*'auto'/);
		expect(config).toContain('directives: CSP_DIRECTIVES');
	});

	it('does not hand-build a CSP header in hooks.server.ts', () => {
		const hooks = fs.readFileSync(path.join(README, 'src/hooks.server.ts'), 'utf8');
		expect(hooks.toLowerCase()).not.toContain('content-security-policy');
	});
});

/**
 * Serialize the real directives through SvelteKit's own Csp class, so the assertion
 * is made against the header SvelteKit will actually emit — nonce on dynamic content
 * pages, hash on prerendered ones.
 */
describe('content page CSP header (SvelteKit serialization)', () => {
	const make = async (prerender: boolean) => {
		// resolve by absolute path: the kit package does not export this deep runtime module
		const cspPath = path.resolve(
			README,
			'node_modules/@sveltejs/kit/src/runtime/server/page/csp.js'
		);
		const { Csp } = (await import(/* @vite-ignore */ pathToFileURL(cspPath).href)) as {
			Csp: new (
				config: { mode: 'auto'; directives: unknown; reportOnly: unknown },
				opts: { prerender: boolean }
			) => {
				nonce: string;
				csp_provider: { get_header(is_meta?: boolean): string };
				add_script(content: string): Promise<void>;
			};
		};
		const csp = new Csp(
			{ mode: 'auto', directives: CSP_DIRECTIVES, reportOnly: {} },
			{ prerender }
		);
		await csp.add_script('console.log("hydration")');
		return csp;
	};

	const scriptSrc = (header: string) =>
		header
			.split('; ')
			.find((d) => d.startsWith('script-src'))
			?.replace('script-src ', '') ?? '';

	it('allows scripts from self with a nonce and never unsafe-inline/unsafe-eval', async () => {
		const header = (await make(false)).csp_provider.get_header();
		expect(header).toContain("default-src 'self'");
		const src = scriptSrc(header);
		expect(src).toContain("'self'");
		expect(src).toMatch(/'nonce-[^']+'/);
		expect(src).not.toContain('unsafe-inline');
		expect(src).not.toContain('unsafe-eval');
	});

	it('uses a hash instead of a nonce on prerendered pages', async () => {
		const header = (await make(true)).csp_provider.get_header();
		const src = scriptSrc(header);
		expect(src).toContain("'self'");
		expect(src).toMatch(/'sha256-[^']+'/);
		expect(src).not.toContain('unsafe-inline');
		expect(src).not.toContain('unsafe-eval');
	});

	it('blocks framing and pins the other hardening directives', async () => {
		const header = (await make(false)).csp_provider.get_header();
		expect(header).toContain("frame-ancestors 'none'");
		expect(header).toContain("object-src 'none'");
		expect(header).toContain("base-uri 'none'");
		expect(header).toContain("form-action 'self'");
		expect(header).toContain("connect-src 'self'");
		expect(header).toContain("worker-src 'self'");
		expect(header).toContain("style-src 'self' 'unsafe-inline'");
	});

	it('never allows unsafe-eval anywhere in the policy', () => {
		const flat = JSON.stringify(CSP_DIRECTIVES);
		expect(flat).not.toContain('unsafe-eval');
	});
});

/** The two routes that had a sandbox CSP before must keep it verbatim. */
describe('sandbox CSP on uploaded files and cached diagrams', () => {
	let dir: string;

	beforeAll(async () => {
		const made = await makeMdwiki();
		dir = made.dir;
		process.env.SPACE_DIR = dir;
		process.env.CACHE_DIR = made.cache;
		const svc = await import('../src/lib/server/service');
		await svc.getMdwiki();
		afterAll(async () => (await svc.getMdwiki()).stop());
	});

	it('keeps the sandbox CSP on /f/*', async () => {
		const rel = 'Syntax.md';
		fs.writeFileSync(path.join(dir, rel), '# ok');
		const { GET } = await import('../src/routes/f/[...path]/+server');
		const request = new Request(`http://localhost/f/${rel}`);
		const res = await (GET as Function)({
			params: { path: rel },
			request,
			url: new URL(request.url)
		});
		expect(res.headers.get('content-security-policy')).toBe(
			"sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'"
		);
	});

	it('keeps the sandbox CSP on /_ui/diagram/*', async () => {
		const cacheDir = process.env.CACHE_DIR!;
		const key = 'a'.repeat(40);
		fs.mkdirSync(cacheDir, { recursive: true });
		fs.writeFileSync(path.join(cacheDir, `${key}.svg`), '<svg></svg>');
		const { GET } = await import('../src/routes/_ui/diagram/[key]/+server');
		const res = await (GET as Function)({ params: { key } });
		expect(res.headers.get('content-security-policy')).toBe(
			"sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"
		);
	});
});
