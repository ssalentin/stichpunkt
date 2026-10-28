import { z } from 'zod';
import { frontmatterTags, parseFrontmatter } from './markdown';

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
			allowed_tags: z.array(z.string()).optional(),
			forbidden_prefixes: z.array(z.string()).optional(),
			stand_field: z.string().min(1).optional(),
			stand_max_age_days: z.number().int().positive().optional(),
			require_agent: z.boolean().optional()
		})
		.optional(),
	folders: z.record(z.string(), folder).optional(),
	/** display names per actor slug; records keep only the slug */
	actors: z.record(z.string(), z.strictObject({ name: z.string().min(1) })).optional(),
	checks: z.array(z.enum(['secrets', 'links', 'frontmatter', 'owner', 'stand_age'])).optional()
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
	rule:
		| 'missing_frontmatter'
		| 'forbidden_prefix'
		| 'unknown_folder'
		| 'possible_secret'
		| 'dead_link'
		| 'tag_not_allowed'
		| 'owner_mismatch'
		| 'stand_missing'
		| 'stand_unparseable'
		| 'stand_stale'
		| 'missing_actor';
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

export interface CheckContext {
	/** the acting agent, when the caller named one */
	agent?: string;
	/** clocks are injectable for tests */
	now?: Date;
}

/** Owner of the top-level folder of `page`, or undefined. Root and MANIFEST have none. */
export function folderOwner(rules: ManifestRules | null, page: string): string | undefined {
	if (!rules?.folders || page === MANIFEST_PAGE || !page.includes('/')) return undefined;
	return rules.folders[page.slice(0, page.indexOf('/'))]?.owner;
}

/** Owner names compare trimmed and case-insensitively; an absent actor or owner never mismatches. */
export function sameActor(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) return true;
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Checks the full resulting content of `page` against the manifest rules. Never throws. */
export function checkPage(rules: ManifestRules | null, page: string, content: string, ctx: CheckContext = {}): PageWarning[] {
	if (!rules) return [];
	const out: PageWarning[] = [];
	const lines = content.split(/\r?\n/);
	const special = page === MANIFEST_PAGE;
	const enabled = new Set(rules.checks ?? []);

	if (rules.pages?.require_agent && !ctx.agent) {
		out.push({ rule: 'missing_actor', message: 'actor unknown' });
	}

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

	if (enabled.has('frontmatter') && !special) {
		const allowed = (rules.pages?.allowed_tags ?? []).map((t) => t.replace(/^#/, '').toLowerCase());
		if (allowed.length) {
			for (const tag of frontmatterTags(parseFrontmatter(content).data)) {
				if (!allowed.includes(tag)) out.push({ rule: 'tag_not_allowed', message: `Tag "#${tag}" is not in pages.allowed_tags` });
			}
		}
	}

	if (enabled.has('owner') && ctx.agent && rules.folders && !special && page.includes('/')) {
		const top = page.slice(0, page.indexOf('/'));
		const owner = rules.folders[top]?.owner;
		if (owner && !sameActor(owner, ctx.agent)) {
			out.push({ rule: 'owner_mismatch', message: `Folder "${top}" is owned by "${owner}", not by "${ctx.agent.trim()}"` });
		}
	}

	if (enabled.has('stand_age') && !special) {
		const field = rules.pages?.stand_field ?? 'updated';
		const maxDays = rules.pages?.stand_max_age_days ?? 90;
		const raw = parseFrontmatter(content).data[field];
		if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
			out.push({ rule: 'stand_missing', message: `Frontmatter key "${field}" is missing` });
		} else {
			const date = parseDateValue(raw);
			if (!date) {
				out.push({ rule: 'stand_unparseable', message: `Frontmatter key "${field}" is not a date the check understands` });
			} else {
				const age = Math.floor(((ctx.now ?? new Date()).getTime() - date.getTime()) / 86_400_000);
				if (age > maxDays) out.push({ rule: 'stand_stale', message: `"${field}" is ${age} days old (limit ${maxDays})` });
			}
		}
	}

	if (enabled.has('secrets')) {
		lines.forEach((l, i) => {
			if (SECRET_PATTERNS.some((re) => re.test(l))) {
				out.push({ rule: 'possible_secret', message: 'This line looks like it contains a credential', line: i + 1 });
			}
		});
	}
	return out;
}

// ---- tolerant dates for the stand_age check -------------------------------------------

const YMD = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?(?:\s+([A-Za-z][A-Za-z0-9_+/-]*))?$/;
const DMY = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(Z|[+-]\d{2}:?\d{2})?(?:\s+([A-Za-z][A-Za-z0-9_+/-]*))?$/;
/** A leading `label:` (e.g. "Stand:") is tolerated and dropped. */
const LABEL = /^[A-Za-z][A-Za-z0-9_ -]{0,20}:\s*(.+)$/;

/**
 * Parses the values a page can carry in its stand field: ISO 8601 (`2026-10-28`,
 * `2026-10-28T14:55Z`, with offset or IANA zone) and `DD.MM.YYYY`, optionally with a time
 * and a zone. Unknown input returns null; the caller turns that into `stand_unparseable`.
 */
export function parseDateValue(raw: unknown): Date | null {
	if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
	if (typeof raw !== 'string') return null;
	let text = raw.trim();
	const labelled = LABEL.exec(text);
	if (labelled) text = labelled[1].trim();
	// full ISO 8601 with milliseconds: Date.parse keeps the fraction, the pattern below does not
	if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) && !/\s[A-Za-z][A-Za-z0-9_+/-]*$/.test(text)) {
		const ts = Date.parse(text);
		if (Number.isFinite(ts)) return new Date(ts);
	}
	const m = YMD.exec(text) ?? DMY.exec(text);
	if (!m) return null;
	const iso = YMD.test(text);
	const year = Number(iso ? m[1] : m[3]);
	const month = Number(iso ? m[2] : m[2]);
	const day = Number(iso ? m[3] : m[1]);
	const hour = Number(m[4] ?? 0);
	const minute = Number(m[5] ?? 0);
	const second = Number(m[6] ?? 0);
	const offset = m[7];
	const zone = m[8];
	if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
	if (hour > 23 || minute > 59 || second > 59) return null;
	if (zone && !offset) {
		const ts = zonedToUtc(year, month, day, hour, minute, second, zone);
		return ts === null ? null : new Date(ts);
	}
	const minutes = offsetMinutes(offset);
	if (minutes === null) return null;
	return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - minutes * 60_000);
}

function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function offsetMinutes(offset: string | undefined): number | null {
	if (!offset) return 0;
	if (offset === 'Z') return 0;
	const m = /^([+-])(\d{2}):?(\d{2})$/.exec(offset);
	if (!m) return null;
	const value = Number(m[2]) * 60 + Number(m[3]);
	return m[1] === '-' ? -value : value;
}

function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, second: number, zone: string): number | null {
	try {
		const guess = Date.UTC(year, month - 1, day, hour, minute, second);
		const first = guess - offsetAt(zone, guess);
		// a second pass lands on the right side of a DST change
		return guess - offsetAt(zone, first);
	} catch {
		return null;
	}
}

function offsetAt(zone: string, ts: number): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: zone,
		hour12: false,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	}).formatToParts(new Date(ts));
	const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
	let hour = get('hour');
	if (hour === 24) hour = 0;
	return Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second')) - ts;
}
