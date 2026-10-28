import { describe, expect, it } from 'vitest';
import { buildIndex, fold, parseQuery, runSearch, snippetAround, splitCompound, stem, tokenize, words } from '../src/lib/server/search';
import { fuzzyScore } from '../src/lib/fuzzy';

const page = (path: string, text: string, extra: { title?: string; tags?: string[]; mtimeMs?: number } = {}) => ({
	path,
	title: extra.title ?? path.slice(path.lastIndexOf('/') + 1),
	tags: extra.tags ?? [],
	headings: [],
	sections: text
		.split(/^## /m)
		.map((chunk, i) => (i === 0 ? { heading: '', slug: '', text: chunk } : { heading: chunk.split('\n')[0], slug: chunk.split('\n')[0].toLowerCase(), text: chunk }))
		.filter((s) => s.text.trim()),
	text,
	mtimeMs: extra.mtimeMs ?? 1000,
	hidden: path.startsWith('Library/')
});

const search = (pages: ReturnType<typeof page>[], query: string, limit = 10) =>
	runSearch(buildIndex(pages), query, { limit, fuzzy: (needle, p) => Math.max(fuzzyScore(needle, p.title), fuzzyScore(needle, p.path)) });

describe('tokenizer', () => {
	it('folds German umlauts for matching and keeps unicode words', () => {
		expect(fold('Über Äpfel und Öl')).toBe('ueber aepfel und oel');
		expect(fold('Straße')).toBe('strasse');
		expect(words('E-Paper, 5.0 TB und Ärzte')).toEqual(['e', 'paper', '5', '0', 'tb', 'und', 'aerzte']);
		expect(tokenize('Straße')).toEqual(['strass']);
	});

	it('strips only enough to match inflection, never short words', () => {
		expect(stem('renten')).toBe(stem('rente'));
		expect(stem('versicherungen')).toBe(stem('versicherung'));
		expect(stem('kinder')).toBe(stem('kind'));
		expect(stem('haus')).toBe('haus');
		expect(stem('kosten')).toBe(stem('kostet'));
	});
});

describe('compound splitting', () => {
	const vocab = new Map([
		['arzt', 4],
		['termin', 6],
		['steuer', 5],
		['erklaer', 3],
		['kranken', 2],
		['versicher', 9],
		['haus', 7],
		['versicherung', 5]
	]);

	it('splits German compounds into parts that exist in the corpus', () => {
		expect(splitCompound('arzttermin', vocab)).toEqual(['arzt', 'termin']);
		expect(splitCompound('steuererklaerung', vocab)).toEqual(['steuer', 'erklaerung']);
		expect(splitCompound('krankenversicherung', vocab)).toEqual(['kranken', 'versicherung']);
	});

	it('refuses to split when a part is unknown', () => {
		expect(splitCompound('arztbesuch', vocab)).toBeNull();
		expect(splitCompound('kurz', vocab)).toBeNull();
	});

	it('finds a compound behind a query word', () => {
		const pages = [page('Gesundheit', 'Beim Arzt einen Termin machen. Der Arzt hilft.'), page('Finanzen', 'Steuer und Abgaben.')];
		const r = search(pages, 'Arzttermin');
		expect(r.results[0].path).toBe('Gesundheit');
		expect(r.results[0].terms).toEqual(expect.arrayContaining(['arzt', 'termin']));
	});
});

describe('ranking', () => {
	const pages = [
		page('Gesundheit', 'Der Arzt hilft. Termine macht man beim Arzt.', { tags: ['gesundheit'] }),
		page('Setup/Backups', 'Backups laufen täglich. Ein Restore-Test gehört dazu.'),
		page('Setup', 'Server, Speicher und Backups im Überblick. Der Server läuft im Keller.'),
		page('Library/Hidden', 'geheimnis arzt')
	];

	it('ranks the page whose title matches', () => {
		expect(search(pages, 'Backups').results[0].path).toBe('Setup/Backups');
	});

	it('prefers the page that covers more of the query', () => {
		const r = search(pages, 'Backup Server');
		expect(r.results[0].path).toBe('Setup');
		expect(r.mode).toBe('and');
	});

	it('falls back to any term when the strict match is thin, with coverage ranking', () => {
		const r = search(pages, 'Server Zahnarzt');
		expect(r.mode).toBe('or');
		expect(r.results.map((h) => h.path)).toContain('Setup');
	});

	it('never exposes hidden pages unless asked', () => {
		expect(search(pages, 'geheimnis').results).toEqual([]);
		const withHidden = runSearch(buildIndex(pages), 'geheimnis', { includeHidden: true });
		expect(withHidden.results[0].path).toBe('Library/Hidden');
	});

	it('keeps quoted phrases together and does not bridge sentences', () => {
		const p = [page('A', 'Install things. Start other things.'), page('B', 'Start things here.')];
		expect(search(p, '"start things"').results.map((h) => h.path)).toEqual(['B']);
		expect(search(p, '"things start"').results).toEqual([]);
	});

	it('applies #tag and in:folder filters before ranking', () => {
		expect(search(pages, '#gesundheit arzt').results.map((h) => h.path)).toEqual(['Gesundheit']);
		expect(search(pages, 'arzt in:Setup').results).toEqual([]);
	});

	it('down-weights agent helper pages under Intern/ but keeps them findable', () => {
		const pages = [
			page('Intern/Ablage-Konvention', 'Arzt Arzt Arzt Termin Termin Termin Übersicht aller Kategorien', { mtimeMs: 5000 }),
			page('Gesundheit', 'Beim Arzt einen Termin machen, der Arzt hilft.', { mtimeMs: 1000 })
		];
		expect(search(pages, 'Arzttermin').results[0].path).toBe('Gesundheit');
		const plain = runSearch(buildIndex(pages), 'Ablage-Konvention');
		expect(plain.results[0].path).toBe('Intern/Ablage-Konvention');
		const internal = runSearch(buildIndex(pages), 'Arzttermin', { includeHidden: true });
		expect(internal.results[0].path).toBe('Intern/Ablage-Konvention');
	});

	it('falls back to fuzzy titles on typos', () => {
		expect(search(pages, 'Gesundhei').results[0].path).toBe('Gesundheit');
	});

	it('builds the snippet around the best match, not the start of the text', () => {
		const text = 'Ein langer Vorlauf ohne Treffer. '.repeat(20) + 'Hier steht der Arzttermin im Kalender.';
		const snippet = snippetAround(text, ['arzt', 'termin']);
		expect(snippet).toContain('Arzttermin');
		expect(snippet.startsWith('…')).toBe(true);
	});
});

describe('query parsing', () => {
	it('separates phrases, tags and folder filters', () => {
		expect(parseQuery('"keine Angst" #meta in:Setup rest')).toEqual({
			terms: ['rest'],
			tags: ['meta'],
			folders: ['setup'],
			phrases: ['keine Angst']
		});
	});
});
