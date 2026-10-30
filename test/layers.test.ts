import { describe, expect, it } from 'vitest';
import { LAYERS, layerInView, layersInView } from '../src/lib/layers';
import { layerLabels, layerOfPage, parseManifest, rulesForLayer } from '../src/lib/server/agent-manifest';
import { makeMdwiki } from './helpers';

const MANIFEST = `---
manifest: 1
summary: layers test
pages:
  allowed_tags: [reading-tag]
folders:
  Notes: {}
  Draft: { layer: working }
  Settings: { layer: config }
layers:
  working:
    label: Workshop
    pages:
      allowed_tags: [draft-tag]
    checks: [links]
---
`;

async function space() {
	const { mdwiki } = await makeMdwiki();
	await mdwiki.writePage('MANIFEST', MANIFEST);
	await mdwiki.writePage('Notes/Reading', 'ordinary public note about a quokka\n');
	await mdwiki.writePage('Draft/Internal', 'working draft about a quokka\n');
	await mdwiki.writePage('Settings/Rules', 'config page about a quokka\n');
	return mdwiki;
}

describe('layer resolution', () => {
	it('defaults to reading and inherits the folder layer', () => {
		const parsed = parseManifest('---\nmanifest: 1\nsummary: s\nfolders:\n  Draft: { layer: working }\n---\n');
		if (!parsed.ok) throw new Error('manifest');
		expect(layerOfPage(parsed.value.rules, 'Draft/Anything/Deep')).toBe('working');
		expect(layerOfPage(parsed.value.rules, 'Notes/Page')).toBe('reading');
		expect(layerOfPage(parsed.value.rules, 'Root')).toBe('reading');
		expect(layerOfPage(null, 'Draft/Page')).toBe('reading');
	});

	it('merges a layer block per key and replaces checks when set', () => {
		const parsed = parseManifest(MANIFEST);
		if (!parsed.ok) throw new Error('manifest');
		const rules = parsed.value.rules;
		const working = rulesForLayer(rules, 'working');
		expect(working.pages?.allowed_tags).toEqual(['draft-tag']);
		expect(working.checks).toEqual(['links']);
		// an unset key inherits the global rule
		expect(working.pages?.required_frontmatter).toBeUndefined();
		expect(rulesForLayer(rules, 'reading')).toBe(rules);
		expect(layerLabels(rules)).toMatchObject({ reading: 'Notes', working: 'Workshop', config: 'Config' });
	});

	it('maps views to layers', () => {
		expect(layersInView('reading')).toEqual(['reading', 'config']);
		expect(layersInView('working')).toEqual(['working']);
		expect(layersInView('all')).toEqual([...LAYERS]);
		expect(layerInView('config', 'reading')).toBe(true);
		expect(layerInView('working', 'reading')).toBe(false);
	});
});

describe('layer visibility in the tools', () => {
	it('hides working pages in search, list_pages and query_pages unless include_working is set', async () => {
		const mdwiki = await space();
		const hidden = mdwiki.search('quokka');
		expect(hidden.results.map((h) => h.path).sort()).toEqual(['Notes/Reading', 'Settings/Rules']);
		expect(hidden.results.every((h) => h.layer !== 'working')).toBe(true);
		expect(hidden.per_page.map((p) => p.path)).not.toContain('Draft/Internal');

		const shown = mdwiki.search('quokka', 30, true);
		expect(shown.results.map((h) => h.path)).toContain('Draft/Internal');
		expect(shown.results.find((h) => h.path === 'Draft/Internal')?.layer).toBe('working');

		// an explicit folder filter is only a filter, it does not unlock the layer
		expect(mdwiki.search('quokka in:Draft').results).toEqual([]);
		expect(mdwiki.search('quokka in:Draft', 30, true).results.map((h) => h.path)).toEqual(['Draft/Internal']);

		const list = mdwiki.listPagesResult('');
		expect(list.pages.map((p) => p.path)).not.toContain('Draft/Internal');
		const listAll = mdwiki.listPagesResult('', { includeWorking: true });
		expect(listAll.pages.find((p) => p.path === 'Draft/Internal')?.layer).toBe('working');

		const query = mdwiki.queryPages({ folder: 'Draft' });
		expect(query.rows).toEqual([]);
		const queryAll = mdwiki.queryPages({ folder: 'Draft' }, '', true);
		expect(queryAll.rows.map((r) => [r.path, r.layer])).toEqual([['Draft/Internal', 'working']]);

		expect((await mdwiki.readPage('Draft/Internal')).layer).toBe('working');
		expect((await mdwiki.readPage('Notes/Reading')).layer).toBe('reading');
		expect((await mdwiki.renderPage('Draft/Internal'))?.layer).toBe('working');
		expect(mdwiki.layers()).toMatchObject({ labels: { reading: 'Notes', working: 'Workshop', config: 'Config' } });
	});

	it('adds layer to search hits and per-page counts', async () => {
		const mdwiki = await space();
		const result = mdwiki.search('quokka');
		expect(result.per_page.length).toBeGreaterThan(0);
		expect(result.per_page[0]).toMatchObject({ path: expect.any(String), count: expect.any(Number), layer: expect.any(String) });
	});

	it('pages paging reports total and truncated', async () => {
		const mdwiki = await space();
		const first = mdwiki.listPagesResult('', { includeWorking: true, limit: 2 });
		expect(first.pages).toHaveLength(2);
		expect(first.total).toBeGreaterThan(2);
		expect(first.truncated).toBe(true);
		const second = mdwiki.listPagesResult('', { includeWorking: true, limit: 2, offset: 2 });
		expect(second.pages[0].path).not.toBe(first.pages[0].path);
		const rest = mdwiki.listPagesResult('', { includeWorking: true, limit: 1000 });
		expect(rest.truncated).toBe(false);
	});

	it('keeps the existing behavior without any layer declaration', async () => {
		const { mdwiki } = await makeMdwiki();
		expect(mdwiki.layerOf('Server/Alpha')).toBe('reading');
		expect(mdwiki.search('zebrafish-needle').results.map((h) => h.path)).toContain('Server/Beta');
		expect(mdwiki.listPagesResult('Server').pages.map((p) => p.path)).toEqual(expect.arrayContaining(['Server', 'Server/Alpha', 'Server/Beta']));
	});
});

describe('check_manifest layers', () => {
	it('reports unknown layer blocks, unused layers and tags without tag.define', async () => {
		const { mdwiki } = await makeMdwiki();
		await mdwiki.writePage('MANIFEST', `---
manifest: 1
summary: s
folders:
  Notes: {}
layers:
  working:
    label: Intern
    pages:
      allowed_tags: [nowhere]
  nonsense: {}
---
`);
		const res = await mdwiki.checkManifest();
		expect(res.ok).toBe(false);
		expect(res.issues).toEqual(
			expect.arrayContaining([
				{ path: 'layers.nonsense', message: expect.stringContaining('Unknown layer') },
				{ path: 'layers.working', message: expect.stringContaining('no folder') },
				{ path: 'layers.working.pages.allowed_tags', message: expect.stringContaining('nowhere') }
			])
		);
	});
});
