/**
 * Golden-list evaluation for the search ranking.
 *
 * Runs outside `npm test` by default (CI has no knowledge base): it needs a real
 * space directory, `SPACE_DIR` or `./space`. Use `npm run search:eval`.
 *
 * Reports hit@3 and the mean rank of the first expected page per query, so a
 * ranking change can be compared before/after in the PR.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/lib/server/config';
import { Mdwiki } from '../src/lib/server/service';

interface Case {
	query: string;
	/** acceptable pages: any of them on rank 1-3 counts as a hit */
	expect: string[];
}

export const GOLDEN: Case[] = [
	{ query: 'Arzttermin', expect: ['Gesundheit'] },
	{ query: 'Steuererklärung', expect: ['Finanzen'] },
	{ query: 'Was kostet die Wohnung', expect: ['Finanzen/mietwohnung-nebenkosten'] },
	{ query: 'Kündigung Versicherung', expect: ['Finanzen/Versicherungen', 'Finanzen/Fristenkalender'] },
	{ query: 'wie viel Rente bekomme ich', expect: ['Finanzen/Altersvorsorge'] },
	{ query: 'Urlaub in Slowenien mit Kindern', expect: ['Freizeitplanung/Slowenien'] },
	{ query: 'welche Agenten gibt es', expect: ['Setup/Agenten'] },
	{ query: 'Backup vom Server', expect: ['Setup/Backups'] },
	{ query: 'wann ist die Schule zu', expect: ['Familie/Schule-und-Kita'] },
	{ query: 'Einkaufsliste', expect: ['Familie/einkaufsliste'] },
	{ query: 'was habe ich zuletzt gelesen', expect: ['Bibliothek/Lesezeichen'] },
	{ query: 'Matrix Bot', expect: ['Setup/Matrix-Agenten'] },
	{ query: 'Versicherung fürs Haus', expect: ['Finanzen/Versicherungen'] },
	{ query: 'Kind krank', expect: ['Gesundheit', 'Familie/Stammdaten'] },
	{ query: 'Domain', expect: ['Setup/Domains'] }
];

const dir = path.resolve(process.env.SPACE_DIR ?? 'space');
const available = fs.existsSync(dir);
const LIMIT = 10;

describe.skipIf(!available)('search golden list', () => {
	it('ranks the expected page in the top 3', async () => {
		const mdwiki = await new Mdwiki(
			loadConfig({ SPACE_DIR: dir, MDWIKI_API_TOKEN: 'eval', POLL_INTERVAL: '600000' } as NodeJS.ProcessEnv)
		).start(false);
		try {
			let hits = 0;
			let rankSum = 0;
			const rows: string[] = [];
			for (const c of GOLDEN) {
				const results = mdwiki.search(c.query, LIMIT).results.map((r) => r.path);
				const index = results.findIndex((p) => c.expect.includes(p));
				const rank = index < 0 ? null : index + 1;
				if (rank && rank <= 3) hits++;
				rankSum += rank ?? LIMIT + 1;
				rows.push(`| ${c.query} | ${c.expect.join(' / ')} | ${rank ?? '–'} | ${results.slice(0, 3).join(', ') || '–'} |`);
			}
			const rate = ((hits / GOLDEN.length) * 100).toFixed(0);
			const mean = (rankSum / GOLDEN.length).toFixed(2);
			console.log(`\n| query | expected | rank | top 3 |\n|---|---|---|---|\n${rows.join('\n')}\n`);
			console.log(`hit@3: ${hits}/${GOLDEN.length} (${rate}%) · mean rank: ${mean}\n`);
			expect(hits / GOLDEN.length).toBeGreaterThanOrEqual(0.8);
		} finally {
			mdwiki.stop();
		}
	});
});
