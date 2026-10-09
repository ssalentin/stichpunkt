export interface Titled {
	path: string;
	title: string;
	mtimeMs: number;
}

/** Subsequence match score (higher is better), or -1 when `q` does not match. */
export function fuzzyScore(q: string, text: string): number {
	if (!q) return 0;
	const t = text.toLowerCase();
	const needle = q.toLowerCase();
	const sub = t.indexOf(needle);
	if (sub >= 0) {
		const wordStart = sub === 0 || /[\s/_-]/.test(t[sub - 1]);
		return 200 + (wordStart ? 60 : 0) - sub - (t.length - needle.length) * 0.5;
	}
	let score = 0;
	let ti = 0;
	let prev = -2;
	for (const ch of needle) {
		const at = t.indexOf(ch, ti);
		if (at < 0) return -1;
		score += at === prev + 1 ? 8 : 1;
		if (at === 0 || /[\s/_-]/.test(t[at - 1])) score += 6;
		prev = at;
		ti = at + 1;
	}
	return score - t.length * 0.2;
}

/** Matches against title and full path; title hits weigh more. Recent pages win ties. */
export function rank(items: Titled[], q: string, recent: string[], limit = 30): Titled[] {
	const rec = new Map(recent.map((p, i) => [p, recent.length - i]));
	if (!q.trim()) {
		const seen = new Set<string>();
		const out: Titled[] = [];
		const byPath = new Map(items.map((i) => [i.path, i]));
		for (const p of recent) {
			const it = byPath.get(p);
			if (it && !seen.has(p)) (seen.add(p), out.push(it));
		}
		for (const it of [...items].sort((a, b) => b.mtimeMs - a.mtimeMs)) {
			if (!seen.has(it.path)) out.push(it);
		}
		return out.slice(0, limit);
	}
	return items
		.map((it) => {
			const a = fuzzyScore(q, it.title);
			const b = fuzzyScore(q, it.path);
			const s = Math.max(a >= 0 ? a + 40 : -1, b);
			return { it, s: s < 0 ? -1 : s + (rec.get(it.path) ?? 0) * 0.5 };
		})
		.filter((x) => x.s >= 0)
		.sort((x, y) => y.s - x.s)
		.slice(0, limit)
		.map((x) => x.it);
}
