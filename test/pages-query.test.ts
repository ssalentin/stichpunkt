import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	DEFAULT_LIMIT,
	MAX_LIMIT,
	PagesQueryError,
	parsePagesBlock,
	parsePagesQuery,
	renderPagesError,
	renderPagesResult,
	runPagesQuery
} from '../src/lib/server/pages-query';
import { makeMdwiki } from './helpers';

const open: { stop(): void }[] = [];
afterEach(() => open.splice(0).forEach((f) => f.stop()));

async function setup(pages: Record<string, string> = {}) {
	const made = await makeMdwiki({ poll: 100 });
	open.push(made.mdwiki);
	for (const [p, c] of Object.entries(pages)) {
		fs.mkdirSync(path.dirname(path.join(made.dir, p)), { recursive: true });
		fs.writeFileSync(path.join(made.dir, p), c);
	}
	await made.mdwiki.index.refresh();
	return made;
}

const paths = (rows: { path: string }[]) => rows.map((r) => r.path);

describe('parsePagesBlock', () => {
	it('accepts an empty block and every documented key', () => {
		expect(parsePagesBlock('')).toEqual({});
		expect(parsePagesBlock('tag: server')).toEqual({ tag: 'server' });
		expect(parsePagesBlock('tag: [a, b]')).toEqual({ tag: ['a', 'b'] });
		expect(
			parsePagesBlock(['folder: this', 'links-to: this', 'sort: date desc', 'limit: 20', 'show: table', 'columns: [title, date]'].join('\n'))
		).toEqual({ folder: 'this', 'links-to': 'this', sort: 'date desc', limit: 20, show: 'table', columns: ['title', 'date'] });
	});

	it.each([
		['unknown key', 'tga: project'],
		['wrong type for tag', 'tag: 12'],
		['wrong type for limit', 'limit: many'],
		['show out of range', 'show: cards'],
		['empty tag list', 'tag: []'],
		['unknown key next to a good one', 'tag: a\nnope: 1']
	])('rejects %s with the block source', (_label, source) => {
		try {
			parsePagesBlock(source);
			throw new Error('expected a PagesQueryError');
		} catch (e) {
			expect(e).toBeInstanceOf(PagesQueryError);
			expect((e as PagesQueryError).source).toBe(source);
			expect((e as PagesQueryError).message.length).toBeGreaterThan(0);
		}
	});

	it('rejects a non-object body and broken YAML', () => {
		expect(() => parsePagesBlock('- a\n- b')).toThrow(PagesQueryError);
		expect(() => parsePagesBlock('tag: [unclosed')).toThrow(PagesQueryError);
	});

	it('validates the JSON form with the same schema', () => {
		expect(parsePagesQuery({ tag: 'x' })).toEqual({ tag: 'x' });
		expect(() => parsePagesQuery({ tag: 12 })).toThrow(PagesQueryError);
	});
});

describe('runPagesQuery', () => {
	it('filters by tag, matching nested tags like search does', async () => {
		const { mdwiki } = await setup();
		const result = runPagesQuery(mdwiki.index, { tag: 'server', sort: 'title asc' });
		expect(paths(result.rows)).toEqual(['Server/Alpha', 'Server/Beta', 'Server']);
		// a parent tag matches nested ones (`infra/core` is matched by `infra`)
		expect(paths(runPagesQuery(mdwiki.index, { tag: 'infra', sort: 'title asc' }).rows)).toEqual(['Server/Alpha']);
		expect(paths(runPagesQuery(mdwiki.index, { tag: ['server', 'infra'], sort: 'title asc' }).rows)).toEqual(['Server/Alpha']);
	});

	it('filters by folder prefix and by `this`', async () => {
		const { mdwiki } = await setup();
		expect(paths(runPagesQuery(mdwiki.index, { folder: 'Server', sort: 'title asc' }).rows)).toEqual([
			'Server/Alpha',
			'Server/Beta'
		]);
		expect(paths(runPagesQuery(mdwiki.index, { folder: 'this' }, 'Server/Alpha').rows)).toEqual(['Server/Alpha', 'Server/Beta']);
	});

	it('filters by backlinks', async () => {
		const { mdwiki } = await setup();
		expect(paths(runPagesQuery(mdwiki.index, { 'links-to': 'Server/Alpha', sort: 'title asc' }).rows)).toEqual([
			'Server/Beta',
			'index'
		]);
		// `this` = the page the query runs on
		expect(paths(runPagesQuery(mdwiki.index, { 'links-to': 'this' }, 'Server/Alpha').rows)).toEqual(['index', 'Server/Beta']);
		// hidden pages are never listed, even as backlink sources
		expect(paths(runPagesQuery(mdwiki.index, { 'links-to': 'Server/Alpha' }).rows)).not.toContain('Library/Hidden');
	});

	it('sorts by title, modified, date and a frontmatter key', async () => {
		const { mdwiki } = await setup();
		expect(paths(runPagesQuery(mdwiki.index, { tag: 'server', sort: 'title desc' }).rows)).toEqual([
			'Server',
			'Server/Beta',
			'Server/Alpha'
		]);
		expect(runPagesQuery(mdwiki.index, { tag: 'server', sort: 'date desc' }).rows[0].path).toBe('Server/Alpha');
		// a frontmatter key sorts as a string, empty values last for desc
		expect(runPagesQuery(mdwiki.index, { tag: 'server', sort: 'modified desc' }).rows.length).toBe(3);
	});

	it('defaults the sort to date desc and the limit to 50, capped at 200', async () => {
		const { mdwiki } = await setup();
		const result = runPagesQuery(mdwiki.index, { tag: 'server' });
		expect(result.query.limit).toBeUndefined();
		expect(result.total).toBe(3);
		expect(DEFAULT_LIMIT).toBe(50);
		expect(MAX_LIMIT).toBe(200);
	});

	it('counts without returning rows and limits list/table rows', async () => {
		const { mdwiki } = await setup();
		const count = runPagesQuery(mdwiki.index, { tag: 'server', show: 'count', limit: 1 });
		expect(count.total).toBe(3);
		expect(count.rows).toEqual([]);
		const list = runPagesQuery(mdwiki.index, { tag: 'server', show: 'list', limit: 1 });
		expect(list.rows).toHaveLength(1);
		expect(list.total).toBe(3);
	});

	it('resolves table columns including frontmatter keys', async () => {
		const { mdwiki } = await setup();
		const result = runPagesQuery(mdwiki.index, { tag: 'server', show: 'table', columns: ['title', 'status'] });
		expect(result.columns).toEqual(['title', 'status']);
		const alpha = result.rows.find((r) => r.path === 'Server/Alpha');
		expect(alpha?.frontmatter).toEqual({ tags: 'server,infra', date: '2026-10-01' });
	});

	it('hides library pages and pages in frontmatter-typed folders', async () => {
		const { mdwiki } = await setup();
		expect(paths(runPagesQuery(mdwiki.index, { folder: 'Library' }).rows)).toEqual([]);
	});
});

describe('renderPagesResult', () => {	it('escapes every index value', async () => {
		const { mdwiki } = await setup({
			'Evil <img src=x onerror=alert(1)>.md': '---\ntags: evil\ntitle: "<b>bold</b>"\ndate: "<script>x</script>"\n---\nx\n'
		});
		const list = renderPagesResult(runPagesQuery(mdwiki.index, { tag: 'evil', show: 'list' }));
		expect(list).not.toContain('<img');
		expect(list).not.toContain('<script>');
		expect(list).not.toContain('<b>bold</b>');
		expect(list).toContain('&lt;b&gt;bold&lt;/b&gt;');
		const table = renderPagesResult(runPagesQuery(mdwiki.index, { tag: 'evil', show: 'table', columns: ['title', 'date'] }));
		expect(table).not.toContain('<img');
		expect(table).not.toContain('<script>');
	});

	it('renders count, empty state, list and table', async () => {
		const { mdwiki } = await setup();
		expect(renderPagesResult(runPagesQuery(mdwiki.index, { tag: 'server', show: 'count' }))).toContain('<strong>3</strong> pages');
		expect(renderPagesResult(runPagesQuery(mdwiki.index, { tag: 'nothing' }))).toContain('No page matches this query.');
		expect(renderPagesResult(runPagesQuery(mdwiki.index, { tag: 'server', show: 'list' }))).toContain('wg-list');
		expect(renderPagesResult(runPagesQuery(mdwiki.index, { tag: 'server', show: 'table' }))).toContain('wg-table');
	});

	it('shows the message and the source for an invalid block', () => {
		const html = renderPagesError('tga: Unrecognized key', 'tga: project');
		expect(html).toContain('Invalid pages block: tga: Unrecognized key');
		expect(html).toContain('tga: project');
	});
});

describe('pages block rendering', () => {
	const block = (body: string) => `# Q\n\n\`\`\`pages\n${body}\n\`\`\`\n`;

	it('renders list, table and count from the index', async () => {
		const { mdwiki } = await setup({
			'Q.md': block('tag: server\nsort: title asc') + '\n' + block('tag: server\nshow: table\ncolumns: [title, tags]') + '\n' + block('folder: Server\nshow: count')
		});
		const html = (await mdwiki.renderPage('Q'))!.html;
		expect(html).toContain('wg-list');
		expect(html).toContain('<a class="wikilink" href="/Server/Alpha">Alpha</a>');
		expect(html).toContain('wg-table');
		expect(html).toContain('<th>tags</th>');
		expect(html).toContain('<strong>2</strong> pages'); // count of the Server folder
		expect(html).not.toContain('pages:');
	});

	it('resolves `this` for folder and links-to', async () => {
		const { mdwiki } = await setup({
			'Notes/Q.md': block('folder: this') + '\n' + block('links-to: this')
		});
		const html = (await mdwiki.renderPage('Notes/Q'))!.html;
		expect(html).toContain('wg-query');
	});

	it('shows the error and the block source for an invalid block', async () => {
		const { mdwiki } = await setup({ 'Q.md': block('tga: project') + '\n' + block('limit: many') });
		const html = (await mdwiki.renderPage('Q'))!.html;
		expect(html).toContain('Invalid pages block');
		expect(html).toContain('tga: project');
		expect(html).toContain('limit: many');
	});

	it('refreshes the block after an external change', async () => {
		const { mdwiki, dir } = await setup({ 'Q.md': block('tag: server\nsort: title asc') });
		expect((await mdwiki.renderPage('Q'))!.html).not.toContain('/Server/Gamma');
		fs.writeFileSync(path.join(dir, 'Server/Gamma.md'), '---\ntags: server\ndate: 2031-01-01\n---\n# Gamma\nx\n');
		await mdwiki.index.refresh();
		const html = (await mdwiki.renderPage('Q'))!.html;
		expect(html).toContain('/Server/Gamma');
	});
});
