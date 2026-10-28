/**
 * Lexical search for the wiki: tokenizer, light German stemming, compound
 * splitting, BM25 over sections and query semantics (AND, then OR, then fuzzy).
 *
 * Everything here is plain TypeScript without dependencies; the index is built
 * in memory from the parsed pages and rebuilt whenever the space changes.
 */

export interface SearchPageInput {
	path: string;
	title: string;
	tags: string[];
	headings: { level: number; text: string }[];
	sections: { heading: string; slug: string; text: string }[];
	text: string;
	mtimeMs: number;
	hidden: boolean;
}

export interface SearchHit {
	path: string;
	title: string;
	folder: string;
	tags: string[];
	section: { heading: string; slug: string };
	snippet: string;
	terms: string[];
	score: number;
}

export interface SearchResult {
	query: string;
	terms: string[];
	filters: { tags: string[]; folders: string[] };
	total: number;
	results: SearchHit[];
	facets: { folders: { name: string; count: number }[]; tags: { name: string; count: number }[] };
	/** how the query was answered: all terms, some terms, or typo tolerance */
	mode: 'and' | 'or' | 'fuzzy';
}

// ---- tokenizer ------------------------------------------------------------------------

const UMLAUTS: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };

/** Lower-cases and folds German umlauts for matching only; display text is untouched. */
export function fold(text: string): string {
	return text.normalize('NFC').toLowerCase().replace(/[äöüß]/g, (c) => UMLAUTS[c]);
}

const WORD = /[\p{L}\p{N}]+/gu;

/** Surface tokens of a text: unicode words, folded, numbers and single letters kept. */
export function words(text: string): string[] {
	const out: string[] = [];
	for (const m of fold(text).matchAll(WORD)) {
		const w = m[0];
		if (w.length > 1 || /\d/.test(w) || /\p{L}/u.test(w)) out.push(w);
	}
	return out;
}

const SUFFIXES = ['ungen', 'ung', 'keit', 'heit', 'lich', 'isch', 'est', 'et', 'en', 'er', 'es', 'em', 'e', 'n', 's'];

/**
 * Light German suffix stripping: enough to match "Rente"/"Renten" and
 * "Versicherung"/"Versicherungen" without a snowball implementation.
 * Words of four letters or fewer stay as they are, and a stem never gets
 * shorter than four letters, which keeps "Haus" and "Kind" intact.
 */
export function stem(word: string): string {
	if (word.length < 5) return word;
	for (const suffix of SUFFIXES) {
		if (!word.endsWith(suffix)) continue;
		const rest = word.slice(0, -suffix.length);
		if (rest.length >= 4) return rest;
	}
	return word;
}

export function tokenize(text: string): string[] {
	return words(text).map(stem);
}

/** Function words that would otherwise force an impossible AND; they stay in the index. */
const STOPWORDS = new Set(
	`
	aber alle allem allen aller alles als also am an ander andere anderem anderen anderer anderes anderm andern anderr
	anders auch auf aus bei bin bis bist da damit dann der den des dem die das dass daß derselbe derselben denselben
	dieser diese dieses diesem diesen dich dir du dies doch dort durch ein eine einem einen einer eines einig einige
	einigem einigen einiger einiges einmal er es etwas euer eure eurem euren eurer eures für gegen gewesen hab habe haben
	hat hatte hatten hier hin hinter ich ihm ihn ihnen ihr ihre ihrem ihren ihrer ihres im in indem ins ist jede jedem
	jeden jeder jedes jene jenem jenen jener jenes jetzt kann kannst können könnte machen man manche manchem manchen
	manncher manches mein meine meinem meinen meiner meines mich mir mit muss musst müssen müßt nach nicht nichts noch
	nun nur ob oder ohne sehr sein seine seinem seinen seiner seines selbst sich sie sind so solche solchem solchen
	solcher solches soll sollen sollte sondern sonst über um und uns unser unsere unserem unseren unserer unseres unter
	viel vom von vor war waren warst was weg weil weiter welche welchem welchen welcher welches wenn werde werden wie
	wieder will wir wird wirst wo wollen wollte würde würden zu zum zur zwar zwischen
	`
		.trim()
		.split(/\s+/)
);

/** Drops function words from a query, but never all of them. */
export function queryTerms(termList: string[]): string[] {
	const content = termList.filter((t) => !STOPWORDS.has(t));
	return content.length ? content : termList;
}

// ---- index ----------------------------------------------------------------------------

interface Section {
	path: string;
	heading: string;
	slug: string;
	text: string;
	/** stemmed tokens in reading order, for phrases and proximity */
	tokens: string[];
	/** tokens per sentence, so a phrase cannot span a sentence break */
	sentences: string[][];
	/** stemmed token -> weighted term frequency */
	tf: Map<string, number>;
	len: number;
}

interface PageIndex {
	hits: SearchPageInput[];
	/** section index lists per page */
	pages: { page: SearchPageInput; sections: number[]; titleTerms: string[]; tagTerms: string[]; pathTerms: string[] }[];
}

export interface SearchIndex {
	sections: Section[];
	byPage: PageIndex['pages'];
	pages: SearchPageInput[];
	df: Map<string, number>;
	vocab: Map<string, number>;
	avgLen: number;
	/** title terms per page, used for field boosts */
	titles: string[][];
	buildMs: number;
}

const FIELD_WEIGHT = { title: 4.5, heading: 1.8, tags: 1.6, path: 0.7 };

/**
 * Splits a compound into two or three parts that all exist in the corpus
 * vocabulary (`arzt|termin`, `steuer|erklaerung`, `kranken|versicherung`).
 * Prefers the split whose parts are the most common, so "gesundheit" does not
 * become "gesund|heit" when "heit" never occurs on its own.
 */
const known = (vocab: Map<string, number>, part: string) => vocab.has(part) || vocab.has(stem(part));

export function splitCompound(word: string, vocab: Map<string, number>, minPart = 3): string[] | null {
	if (word.length < 2 * minPart + 1) return null;
	let best: { parts: string[]; score: number } | null = null;
	const consider = (parts: string[]) => {
		if (parts.some((p) => p.length < minPart)) return;
		let score = 0;
		for (const p of parts) {
			const n = vocab.get(p) ?? vocab.get(stem(p)) ?? 0;
			if (!n) return;
			score += Math.log2(1 + n);
		}
		// fewer parts win ties, more common parts win in general
		score -= (parts.length - 2) * 0.5;
		if (!best || score > best.score) best = { parts, score };
	};
	for (let i = minPart; i <= word.length - minPart; i++) {
		const left = word.slice(0, i);
		const right = word.slice(i);
		if (known(vocab, left) && known(vocab, right)) consider([left, right]);
		// three parts: only where the two-part split did not work out
		for (let j = minPart; j <= right.length - minPart; j++) {
			const mid = right.slice(0, j);
			const last = right.slice(j);
			if (known(vocab, left) && known(vocab, mid) && known(vocab, last)) consider([left, mid, last]);
		}
	}
	return best ? (best as { parts: string[] }).parts : null;
}

/** Builds the BM25 index in two passes: vocabulary first, then weighted postings. */
export function buildIndex(pages: SearchPageInput[], now = Date.now()): SearchIndex {
	const t0 = now;
	const sections: Section[] = [];
	const byPage: PageIndex['pages'] = [];
	const vocab = new Map<string, number>();
	const titles: string[][] = [];

	// pass 1: vocabulary (folded, unstemmed) so compound splits test real words
	for (const p of pages) {
		const add = (w: string) => {
			vocab.set(w, (vocab.get(w) ?? 0) + 1);
			const st = stem(w);
			if (st !== w) vocab.set(st, (vocab.get(st) ?? 0) + 1);
		};
		for (const w of words(p.title)) add(w);
		for (const t of p.tags) for (const w of words(t)) add(w);
		for (const s of p.sections) for (const w of words(s.text)) add(w);
	}

	// pass 2: postings; compounds also contribute their parts, at a lower weight
	for (const p of pages) {
		const sectionIds: number[] = [];
		const rawSections = p.sections.length ? p.sections : [{ heading: '', slug: '', text: p.text }];
		for (const s of rawSections) {
			const surface = words(s.text);
			const tokens = surface.map(stem);
			const sentences = s.text
				.split(/(?:[.!?;:…]|\n)+/)
				.map((chunk) => words(chunk).map(stem))
				.filter((chunk) => chunk.length);
			const tf = new Map<string, number>();
			for (let i = 0; i < tokens.length; i++) {
				const t = tokens[i];
				tf.set(t, (tf.get(t) ?? 0) + 1);
				const parts = splitCompound(surface[i], vocab);
				if (parts) for (const part of parts) tf.set(stem(part), (tf.get(stem(part)) ?? 0) + 0.5);
			}
			sectionIds.push(sections.length);
			sections.push({ path: p.path, heading: s.heading, slug: s.slug, text: s.text, tokens, sentences, tf, len: Math.max(tokens.length, 1) });
		}
		titles.push(p.title ? tokenize(p.title) : []);
		byPage.push({
			page: p,
			sections: sectionIds,
			titleTerms: p.title ? tokenize(p.title) : [],
			tagTerms: p.tags.flatMap(tokenize),
			pathTerms: tokenize(p.path.replace(/\//g, ' '))
		});
	}

	const df = new Map<string, number>();
	for (const s of sections) for (const t of s.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
	const avgLen = sections.reduce((n, s) => n + s.len, 0) / Math.max(sections.length, 1);
	return { sections, byPage, pages, df, vocab, avgLen, titles, buildMs: Date.now() - t0 };
}

// ---- query ----------------------------------------------------------------------------

export interface ParsedQuery {
	terms: string[];
	tags: string[];
	folders: string[];
	phrases: string[];
}

/** Splits a query into terms, "quoted phrases" and `#tag` / `in:folder` filters. */
export function parseQuery(q: string): ParsedQuery {
	const terms: string[] = [];
	const tags: string[] = [];
	const folders: string[] = [];
	const phrases: string[] = [];
	for (const m of q.matchAll(/"([^"]+)"|(\S+)/g)) {
		if (m[1] !== undefined) {
			phrases.push(m[1]);
			continue;
		}
		const raw = m[2].toLowerCase();
		if (raw.startsWith('#') && raw.length > 1) tags.push(raw.slice(1));
		else if (raw.startsWith('in:') && raw.length > 3) folders.push(raw.slice(3).replace(/\/+$/, ''));
		else terms.push(raw);
	}
	return { terms, tags, folders, phrases };
}

/** One meaning in the query: a word, or a compound that may match by its parts. */
interface Concept {
	parts: string[];
	surface: string[];
	weight: number;
}

function conceptsOf(term: string, vocab: Map<string, number>): Concept {
	const folded = fold(term);
	const stemmed = stem(folded);
	if (vocab.has(stemmed)) return { parts: [stemmed], surface: [term], weight: 1 };
	const parts = splitCompound(folded, vocab);
	if (parts) {
		const p = parts.map(stem);
		return { parts: p, surface: parts, weight: 0.85 + 0.15 * p.length };
	}
	return { parts: [stemmed], surface: [term], weight: 1 };
}

interface Scored {
	page: PageIndex['pages'][number];
	score: number;
	/** how many query concepts matched */
	covered: number;
	/** every quoted phrase was found */
	phrasesOk: boolean;
	section: number;
	/** stemmed forms that matched, resolved to surface words when the hit is built */
	highlight: Set<string>;
}

function idf(index: SearchIndex, term: string): number {
	const n = index.sections.length;
	const df = index.df.get(term) ?? 0;
	return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

const K1 = 1.2;
const B = 0.72;

function bm25(tf: number, len: number, avgLen: number, termIdf: number): number {
	return (termIdf * (tf * (K1 + 1))) / (tf + K1 * (1 - B + (B * len) / Math.max(avgLen, 1)));
}

/**
 * Runs the ranking over the index. Filters (#tag, in:folder) are applied before
 * scoring; quoted phrases must occur verbatim. When all terms together match
 * fewer than three pages, the ranking falls back to any term with a coverage
 * penalty, and finally to fuzzy title matching.
 */
export function runSearch(
	index: SearchIndex,
	query: string,
	opts: { limit?: number; includeHidden?: boolean; fuzzy?: (needle: string, page: SearchPageInput) => number; now?: number } = {}
): SearchResult {
	const limit = opts.limit ?? 30;
	const parsed = parseQuery(query);
	const filters = { tags: parsed.tags, folders: parsed.folders };
	const empty: SearchResult = { query, terms: [], filters, total: 0, results: [], facets: { folders: [], tags: [] }, mode: 'and' };
	if (!parsed.terms.length && !parsed.phrases.length && !parsed.tags.length && !parsed.folders.length) return empty;

	const visible = index.byPage.filter((p) => !p.page.hidden || opts.includeHidden);
	const allowed = visible.filter((p) => {
		const lowPath = p.page.path.toLowerCase();
		if (parsed.folders.length && !parsed.folders.every((f) => lowPath.startsWith(f.toLowerCase() + '/'))) return false;
		if (parsed.tags.length && !parsed.tags.every((t) => p.page.tags.some((x) => x.toLowerCase() === t || x.toLowerCase().startsWith(t + '/')))) return false;
		return true;
	});

	// split query words like documents are split ("quokka-marker" -> quokka + marker)
	const concepts = queryTerms(parsed.terms.flatMap((t) => words(t))).map((t) => conceptsOf(t, index.vocab));
	const phrases = parsed.phrases.map((p) => tokenize(p)).filter((p) => p.length);
	// highlight the words the reader typed, and the compounds' parts
	const surfaceTerms = parsed.terms.length ? parsed.terms : parsed.phrases;
	if (!concepts.length && !phrases.length) {
		// filter-only query: newest matching pages first
		const hits = allowed
			.sort((a, b) => b.page.mtimeMs - a.page.mtimeMs)
			.slice(0, limit)
			.map((p) => hitOf(p, index, 1, p.sections[0] ?? 0, new Set()));
		return finish(empty, hits, allowed, query, surfaceTerms, 'and');
	}

	// phrases are mandatory; everything else is ranked with a coverage penalty, so
	// pages matching all words still win over pages matching only some of them
	const scored = rank(index, allowed, concepts, phrases);
	let mode: SearchResult['mode'] = 'or';
	const top = scored[0];
	if (top && top.covered === concepts.length && top.phrasesOk) mode = 'and';
	let matched = scored.map((s) => s.page);
	let hits = scored.slice(0, limit).map((s) => hitOf(s.page, index, s.score, s.section, s.highlight));

	if (!hits.length && surfaceTerms.length && opts.fuzzy) {
		mode = 'fuzzy';
		const needle = surfaceTerms.join(' ');
		const candidates = allowed
			.map((p) => ({ p, score: Math.max(opts.fuzzy!(needle, p.page), opts.fuzzy!(needle, { ...p.page, title: p.page.path })) }))
			.filter((c) => c.score >= 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, 3);
		hits = candidates.map((c) => hitOf(c.p, index, c.score, c.p.sections[0] ?? 0, new Set()));
		matched = candidates.map((c) => c.p);
	}
	return finish(empty, hits, matched, query, surfaceTerms, mode);
}

/** Ranks pages by BM25 over sections and fields, with a coverage penalty for partial matches. */
function rank(index: SearchIndex, pages: PageIndex['pages'], concepts: Concept[], phrases: string[][]): Scored[] {
	const out: Scored[] = [];
	const phraseIdf = phrases.map((p) => p.reduce((n, t) => n + idf(index, t), 0));
	for (const p of pages) {
		let score = 0;
		let covered = 0;
		let bestSection = -1;
		let bestSectionScore = 0;
		const highlight = new Set<string>();
		let phraseOk = true;

		for (const concept of concepts) {
			let best = 0;
			let total = 0;
			let at = -1;
			const partIdf = concept.parts.map((t) => idf(index, t));
			const partBest = concept.parts.map(() => 0);
			for (const sid of p.sections) {
				const s = index.sections[sid];
				let local = 0;
				for (let i = 0; i < concept.parts.length; i++) {
					const tf = s.tf.get(concept.parts[i]);
					if (!tf) continue;
					const sc = bm25(tf, s.len, index.avgLen, partIdf[i]);
					local += sc;
					if (sc > partBest[i]) partBest[i] = sc;
				}
				total += local;
				if (local > best) {
					best = local;
					at = sid;
				}
			}
			// the parts of a compound may be discussed in different sections; both together
			// are stronger evidence than one passing mention (kept slightly below a single dense section)
			if (concept.parts.length > 1) best = Math.max(best, 1.05 * partBest.reduce((a, b) => a + b, 0));
			// a page that discusses the term in several sections beats a single passing mention
			best += Math.min(best * 0.25, total * 0.2);
			// title, heading, tag and path hits count even when the body does not
			const inTitle = intersects(p.titleTerms, concept.parts);
			const inTags = intersects(p.tagTerms, concept.parts);
			const inPath = intersects(p.pathTerms, concept.parts);
			let fieldScore = 0;
			if (inTitle) fieldScore += FIELD_WEIGHT.title * avgIdf(partIdf);
			if (inTags) fieldScore += FIELD_WEIGHT.tags * avgIdf(partIdf);
			if (inPath) fieldScore += FIELD_WEIGHT.path * avgIdf(partIdf);
			let inHeading = false;
			for (const sid of p.sections) {
				const head = index.sections[sid].tokens;
				if (intersects(head, concept.parts)) {
					fieldScore += FIELD_WEIGHT.heading * avgIdf(partIdf);
					inHeading = true;
					break;
				}
			}
			const matched = best > 0 || inTitle || inTags || inPath || inHeading;
			if (matched) {
				covered++;
				// matching more parts of a compound beats matching a single part
				const partsHit = concept.parts.filter(
					(part) =>
						p.titleTerms.includes(part) ||
						p.tagTerms.includes(part) ||
						p.pathTerms.includes(part) ||
						p.sections.some((sid) => index.sections[sid].tf.has(part))
				).length;
				const partFactor = concept.parts.length > 1 ? 1 + 0.6 * (partsHit - 1) : 1;
				score += (best + fieldScore) * partFactor;
				for (const part of concept.parts) if (index.df.has(part)) highlight.add(part);
				for (const surface of concept.surface) highlight.add(surface);
				if (at >= 0 && best >= bestSectionScore) {
					bestSectionScore = best;
					bestSection = at;
				}
			}
		}

		// quoted phrases must occur verbatim in the title or one section
		for (let i = 0; i < phrases.length; i++) {
			const phrase = phrases[i];
			const inTitle = containsSequence(p.titleTerms, phrase);
			let sectionAt = -1;
			for (const sid of p.sections) {
				if (index.sections[sid].sentences.some((sent) => containsSequence(sent, phrase))) {
					sectionAt = sid;
					break;
				}
			}
			if (!inTitle && sectionAt < 0) {
				phraseOk = false;
				break;
			}
			score += 6 + phraseIdf[i] * 1.5;
			if (sectionAt >= 0 && bestSection < 0) bestSection = sectionAt;
			for (const t of phrase) highlight.add(t);
		}

		if (!phraseOk) continue; // quoted phrases are not negotiable
		if (!concepts.length && !phrases.length) continue;
		if (covered === 0 && !phrases.length) continue;

		// proximity: distinct concepts close together in the same section rank higher
		const proximity = bestSection >= 0 ? proximityBoost(index.sections[bestSection].tokens, concepts) : 0;
		score += proximity;

		const need = Math.max(concepts.length, 1);
		const coverage = covered / need;
		score *= 0.5 + 0.5 * coverage;

		out.push({ page: p, score, covered, phrasesOk: phraseOk, section: bestSection >= 0 ? bestSection : (p.sections[0] ?? 0), highlight });
	}
	return out.sort((a, b) => b.score - a.score || b.page.page.mtimeMs - a.page.page.mtimeMs);
}

const intersects = (tokens: string[], parts: string[]) => parts.some((p) => tokens.includes(p));
const avgIdf = (idfs: number[]) => idfs.reduce((a, b) => a + b, 0) / Math.max(idfs.length, 1);

function containsSequence(tokens: string[], needle: string[]): boolean {
	if (!needle.length) return false;
	outer: for (let i = 0; i + needle.length <= tokens.length; i++) {
		for (let j = 0; j < needle.length; j++) if (tokens[i + j] !== needle[j]) continue outer;
		return true;
	}
	return false;
}

/** Small bonus when different concepts share a window of eight tokens. */
function proximityBoost(tokens: string[], concepts: Concept[]): number {
	if (concepts.length < 2) return 0;
	const marks = tokens.map((t) => concepts.findIndex((c) => c.parts.includes(t)));
	const window = 8;
	let best = 0;
	for (let i = 0; i < marks.length; i++) {
		if (marks[i] < 0) continue;
		const seen = new Set<number>([marks[i]]);
		for (let j = i + 1; j < Math.min(marks.length, i + window); j++) {
			if (marks[j] >= 0) seen.add(marks[j]);
		}
		best = Math.max(best, seen.size);
	}
	return best > 1 ? (best - 1) * 1.6 : 0;
}

function hitOf(page: PageIndex['pages'][number], index: SearchIndex, score: number, sectionId: number, highlight: Set<string>): SearchHit {
	const section = index.sections[sectionId];
	const surfaces = surfaceWords(section?.text ?? page.page.text, highlight);
	return {
		path: page.page.path,
		title: page.page.title,
		folder: page.page.path.includes('/') ? page.page.path.slice(0, page.page.path.lastIndexOf('/')) : '',
		tags: page.page.tags.slice(0, 5),
		section: section ? { heading: section.heading, slug: section.slug } : { heading: '', slug: '' },
		snippet: snippetAround(section?.text ?? page.page.text, surfaces),
		terms: surfaces,
		score
	};
}

/** The words of `text` whose stems matched, in their original spelling, for highlighting. */
function surfaceWords(text: string, stems: Set<string>): string[] {
	const out = new Set<string>();
	for (const w of words(text)) {
		if (stems.has(stem(w))) out.add(w);
		if (out.size >= 12) break;
	}
	return [...out];
}

/**
 * Snippet around the densest cluster of matched terms, not the first 160 chars.
 * Falls back to the section intro when nothing matches literally.
 */
export function snippetAround(text: string, terms: string[], width = 220): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	if (!flat) return '';
	if (!terms.length) return flat.slice(0, width).trim() + (flat.length > width ? ' …' : '');
	const lower = fold(flat);
	// prefer matches on word boundaries, then any occurrence
	const spots: number[] = [];
	for (const term of terms) {
		for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + term.length)) {
			spots.push(at);
			if (spots.length > 60) break;
		}
	}
	if (!spots.length) return flat.slice(0, width).trim() + (flat.length > width ? ' …' : '');
	spots.sort((a, b) => a - b);
	let bestAt = spots[0];
	let bestCount = 0;
	for (const at of spots) {
		const from = Math.max(0, at - 60);
		const to = from + width;
		const distinct = new Set(spots.filter((s) => s >= from && s < to).map((s) => s)).size;
		if (distinct > bestCount) {
			bestCount = distinct;
			bestAt = at;
		}
	}
	const start = Math.max(0, Math.min(bestAt - 60, Math.max(0, flat.length - width)));
	const end = Math.min(flat.length, start + width);
	return (start > 0 ? '… ' : '') + flat.slice(start, end).trim() + (end < flat.length ? ' …' : '');
}

function finish(
	empty: SearchResult,
	hits: SearchHit[],
	all: PageIndex['pages'],
	query: string,
	terms: string[],
	mode: SearchResult['mode']
): SearchResult {
	const folderCounts = new Map<string, number>();
	const tagCounts = new Map<string, number>();
	for (const p of all) {
		const top = p.page.path.includes('/') ? p.page.path.slice(0, p.page.path.indexOf('/')) : '';
		folderCounts.set(top, (folderCounts.get(top) ?? 0) + 1);
		for (const t of p.page.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
	}
	const highlight = [...new Set(hits.flatMap((h) => h.terms))];
	const shownTerms = highlight.length ? highlight : terms;
	const top = (m: Map<string, number>, n: number) =>
		[...m.entries()]
			.filter(([k]) => k)
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, n)
			.map(([name, count]) => ({ name, count }));
	return {
		...empty,
		terms: shownTerms,
		total: all.length,
		results: hits,
		facets: { folders: top(folderCounts, 8), tags: top(tagCounts, 10) },
		mode
	};
}

/** Typo tolerance for the last resort: best fuzzy score over title and path. */
export function fuzzyFallback(fuzzy: (needle: string, text: string) => number) {
	return (needle: string, page: SearchPageInput) => Math.max(fuzzy(needle, page.title), fuzzy(needle, page.path));
}
