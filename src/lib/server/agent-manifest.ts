import { z } from 'zod';
import { parseFrontmatter } from './markdown';

/** The special page holding the agent manifest (`MANIFEST.md` in the space root). */
export const MANIFEST_PAGE = 'MANIFEST';

const folder = z.strictObject({
	owner: z.string().optional(),
	template: z.string().optional(),
	description: z.string().optional()
});

/** Strict on every level: an unknown key is invalid, so a typo never silently disables a rule. */
export const manifestSchema = z.strictObject({
	manifest: z.literal(1),
	summary: z.string().min(1).max(2000),
	pages: z
		.strictObject({
			required_frontmatter: z.array(z.string()).optional(),
			forbidden_prefixes: z.array(z.string()).optional()
		})
		.optional(),
	folders: z.record(z.string(), folder).optional(),
	checks: z.array(z.enum(['secrets', 'links'])).optional()
});

export type ManifestRules = z.infer<typeof manifestSchema>;

export interface ManifestIssue {
	path: (string | number)[];
	message: string;
}

export interface ParsedManifest {
	rules: ManifestRules;
	prose: string;
}

export type ManifestParse = { ok: true; value: ParsedManifest } | { ok: false; issues: ManifestIssue[] };

export interface PageWarning {
	rule: 'missing_frontmatter' | 'forbidden_prefix' | 'unknown_folder' | 'possible_secret' | 'dead_link';
	message: string;
	line?: number;
}

export function parseManifest(raw: string): ManifestParse {
	const fm = parseFrontmatter(raw);
	if (fm.error) return { ok: false, issues: [{ path: [], message: `Frontmatter is not valid YAML: ${fm.error}` }] };
	const res = manifestSchema.safeParse(fm.data);
	if (!res.success) {
		return { ok: false, issues: res.error.issues.map((i) => ({ path: i.path.map((p) => (typeof p === 'symbol' ? String(p) : p)), message: i.message })) };
	}
	return { ok: true, value: { rules: res.data, prose: fm.body } };
}

/** What the MCP `initialize` response tells every connecting agent. */
export function manifestInstructions(rules: ManifestRules): string {
	return (
		`${rules.summary}\n\n` +
		'Full rules: call the `get_manifest` tool. Change the manifest itself with `write_page("MANIFEST", ..., base_hash)`.'
	);
}

/**
 * Fixed pattern list for `possible_secret`. Deliberately narrow: each pattern is a well-known
 * credential shape, so a hit is worth a warning. The finding reports the rule and line only.
 */
export const SECRET_PATTERNS: RegExp[] = [
	/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/,
	/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/,
	/\bsk-[A-Za-z0-9_-]{20,}/,
	/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
	/\bxox[abeprs]-[A-Za-z0-9-]{10,}/,
	/\bBearer\s+[A-Za-z0-9._~+/=-]{32,}/i
];

/** Checks the full resulting content of `page` against the manifest rules. Never throws. */
export function checkPage(rules: ManifestRules | null, page: string, content: string): PageWarning[] {
	if (!rules) return [];
	const out: PageWarning[] = [];
	const lines = content.split(/\r?\n/);
	const special = page === MANIFEST_PAGE;

	const required = rules.pages?.required_frontmatter ?? [];
	if (required.length && !special) {
		const fm = parseFrontmatter(content);
		if (fm.error) {
			out.push({ rule: 'missing_frontmatter', message: 'Frontmatter is not valid YAML', line: 1 });
		} else {
			for (const key of required) {
				if (!Object.prototype.hasOwnProperty.call(fm.data, key)) {
					out.push({ rule: 'missing_frontmatter', message: `Frontmatter key "${key}" is missing` });
				}
			}
		}
	}

	const prefixes = (rules.pages?.forbidden_prefixes ?? []).filter((p) => p !== '');
	if (prefixes.length) {
		let fence: { ch: string; len: number } | null = null;
		lines.forEach((raw, i) => {
			const t = raw.trim();
			const m = /^(`{3,}|~{3,})/.exec(t);
			if (fence) {
				if (m && m[1][0] === fence.ch && m[1].length >= fence.len && t === m[1]) fence = null;
				return;
			}
			if (m) {
				fence = { ch: m[1][0], len: m[1].length };
				return;
			}
			const hit = prefixes.find((p) => t.startsWith(p));
			if (hit !== undefined) out.push({ rule: 'forbidden_prefix', message: `Line starts with forbidden prefix "${hit}"`, line: i + 1 });
		});
	}

	if (rules.folders && !special && page.includes('/')) {
		const top = page.slice(0, page.indexOf('/'));
		if (!Object.prototype.hasOwnProperty.call(rules.folders, top)) {
			out.push({ rule: 'unknown_folder', message: `Folder "${top}" is not declared in the manifest` });
		}
	}

	if (rules.checks?.includes('secrets')) {
		lines.forEach((l, i) => {
			if (SECRET_PATTERNS.some((re) => re.test(l))) {
				out.push({ rule: 'possible_secret', message: 'This line looks like it contains a credential', line: i + 1 });
			}
		});
	}
	return out;
}
