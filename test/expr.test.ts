import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	evaluate,
	evaluateNode,
	parseExpr,
	truncateStrings,
	ExprParseError,
	ExprRuntimeError,
	QueryBudget,
	MAX_EXPR_CHARS,
	MAX_EXPRS_PER_PAGE,
	MAX_AST_DEPTH,
	MAX_STEPS,
	MAX_ENGINE_QUERIES,
	MAX_STRING_CHARS,
	usesToday,
	type EvalContext,
	type Node,
	type Value
} from '../src/lib/server/expr';
import { renderValue, valueToText } from '../src/lib/server/expr-render';
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

let ctx: EvalContext;
async function ctxFor(pages: Record<string, string> = {}, self = 'Query', now = new Date('2026-10-09T12:00:00Z')) {
	const made = await setup(pages);
	ctx = { index: made.mdwiki.index, self, budget: new QueryBudget(), now };
	return made;
}

/** Evaluates `src` against the last ctx built by ctxFor (or a bare numeric context). */
const evalS = (src: string) => evaluate(src, ctx);

// ---- parser: binding power and literals -----------------------------------------------

describe('parser: binding power', () => {
	it('honours arithmetic precedence and associativity', async () => {
		await ctxFor();
		expect(evalS('1 + 2 * 3')).toBe(7);
		expect(evalS('(1 + 2) * 3')).toBe(9);
		expect(evalS('10 - 3 - 2')).toBe(5); // left-associative
		expect(evalS('2 * 3 % 4')).toBe(2);
		expect(evalS('-2 + 3')).toBe(1);
		expect(evalS('- -3')).toBe(3);
		expect(evalS('20 / 5 / 2')).toBe(2);
	});

	it('honours comparisons and logic precedence', async () => {
		await ctxFor();
		expect(evalS('1 + 1 == 2')).toBe(true);
		expect(evalS('2 > 1 and 1 > 2')).toBe(false);
		expect(evalS('2 > 1 or 1 > 2')).toBe(true);
		expect(evalS('not (1 > 2)')).toBe(true);
		expect(evalS('not false')).toBe(true);
		expect(evalS('not null')).toBe(true);
		expect(evalS('1 < 2 == true')).toBe(true);
		expect(evalS('"a" < "b"')).toBe(true);
	});

	it('handles ?? with nil-coalescing and the ternary', async () => {
		await ctxFor();
		expect(evalS('null ?? "x"')).toBe('x');
		expect(evalS('1 ?? 2')).toBe(1);
		expect(evalS('null ?? null ?? 3')).toBe(3);
		expect(evalS('true ? "y" : "n"')).toBe('y');
		expect(evalS('1 > 2 ? "y" : "n"')).toBe('n');
		expect(evalS('false ? 1 : true ? 2 : 3')).toBe(2);
	});

	it('parses field access tighter than operators and calls on results', async () => {
		await ctxFor();
		const node = parseExpr('page("Server/Alpha").title == "Alpha"').node;
		expect(node.k).toBe('bin');
		const { value } = { value: evaluate('page("Server/Alpha").fm.tags', ctx) };
		expect(value).toEqual(['server', 'infra']);
	});
});

describe('parser: identifiers', () => {
	it('a hyphen after a name is the minus operator', async () => {
		await ctxFor({ 'Query.md': '---\nbudget: 100\n"due-date": 2026-10-01\n---\n# Query\n' });
		expect(evalS('this.fm.budget - 10')).toBe(90);
		expect(evalS('this.fm.budget-10')).toBe(90);
	});
});

describe('parser: literals and escapes', () => {
	it('parses numbers including decimals and exponents', async () => {
		await ctxFor();
		expect(evalS('42')).toBe(42);
		expect(evalS('3.5')).toBe(3.5);
		expect(evalS('.5')).toBe(0.5);
		expect(evalS('1e3')).toBe(1000);
		expect(evalS('1.5e-2')).toBeCloseTo(0.015);
	});

	it('parses strings with the four escapes', async () => {
		await ctxFor();
		expect(evalS('"a\\"b"')).toBe('a"b');
		expect(evalS("'a\\'b'")).toBe("a'b");
		expect(evalS('"a\\\\b"')).toBe('a\\b');
		expect(evalS('"a\\nb"')).toBe('a\nb');
		expect(evalS("'single' + \"-\" + 'double'")).toBe('single-double');
	});

	it('parses booleans, null, lists and objects', async () => {
		await ctxFor();
		expect(evalS('true')).toBe(true);
		expect(evalS('false')).toBe(false);
		expect(evalS('null')).toBe(null);
		expect(evalS('[1, 2, 3]')).toEqual([1, 2, 3]);
		expect(evalS('[]')).toEqual([]);
		const obj = evalS('{a: 1, "b c": 2}') as { rec: Map<string, Value> };
		expect(obj.rec.get('a')).toBe(1);
		expect(obj.rec.get('b c')).toBe(2);
	});

	it('rejects the things the grammar does not have', () => {
		expect(() => parseExpr('a = 1')).toThrow(ExprParseError);
		expect(() => parseExpr('1 ++')).toThrow(ExprParseError);
		expect(() => parseExpr('["a"][0]')).toThrow(ExprParseError);
		expect(() => parseExpr('x => x')).toThrow(ExprParseError);
		expect(() => parseExpr('a ? b')).toThrow(ExprParseError);
		expect(() => parseExpr('"unterminated')).toThrow(ExprParseError);
		expect(() => parseExpr('for i in x do end')).toThrow(ExprParseError);
	});
});

// ---- evaluator: every builtin ---------------------------------------------------------

describe('evaluator: builtins', () => {
	it('count and pages run the same engine as the pages block', async () => {
		await ctxFor({
			'Projects/A.md': '---\ntags: [project]\nstatus: active\nbudget: 100\n---\nx\n',
			'Projects/B.md': '---\ntags: [project]\nstatus: active\nbudget: 250.5\n---\nx\n',
			'Projects/C.md': '---\ntags: [project]\nstatus: planned\nbudget: 50\n---\nx\n'
		});
		expect(evalS('count({tag: "project"})')).toBe(3);
		const list = evalS('pages({tag: "project"})') as Value[];
		expect(list).toHaveLength(3);
		expect((list[0] as { path: string }).path).toBe('Projects/A');
	});

	it('pages accepts this in folder and links-to, like a pages block', async () => {
		await ctxFor(
			{
				'Folder/Here.md': '---\ntags: [x]\n---\n# Here\n',
				'Folder/Other.md': '---\ntags: [x]\n---\n[[Folder/Here]]\n',
				'Elsewhere.md': '---\ntags: [x]\n---\nx\n'
			},
			'Folder/Here'
		);
		expect(evalS('count({folder: this, tag: "x"})')).toBe(2);
		expect(evalS('count({"links-to": this, tag: "x"})')).toBe(1);
	});

	it('page() returns a record or null and resolves by name', async () => {
		await ctxFor({ 'Server/Alpha.md': '---\ntags: [server]\n---\n# Alpha\n' });
		const p = evalS('page("Server/Alpha")') as { title: string; path: string };
		expect(p.path).toBe('Server/Alpha');
		expect(p.title).toBe('Alpha');
		expect(evalS('page("Server/Ghost")')).toBe(null);
	});

	it('sum, min, max and avg over a page list and a number list', async () => {
		await ctxFor({
			'Projects/A.md': '---\ntags: [project]\nbudget: 100\n---\nx\n',
			'Projects/B.md': '---\ntags: [project]\nbudget: 250.5\n---\nx\n',
			'Projects/C.md': '---\ntags: [project]\nstatus: planned\n---\nx\n'
		});
		expect(evalS('sum(pages({tag: "project"}), "budget")')).toBeCloseTo(350.5);
		expect(evalS('min(pages({tag: "project"}), "budget")')).toBe(100);
		expect(evalS('max(pages({tag: "project"}), "budget")')).toBe(250.5);
		expect(evalS('avg(pages({tag: "project"}), "budget")')).toBeCloseTo(175.25);
		// a missing field and a non-number are skipped, an empty list averages to null
		expect(evalS('avg(pages({tag: "project"}), "nope")')).toBe(null);
		expect(evalS('avg([], "x")')).toBe(null);
		expect(evalS('sum([1, 2, "3"])')).toBe(6);
	});

	it('len, join, lower, upper and round', async () => {
		await ctxFor();
		expect(evalS('len([1, 2, 3])')).toBe(3);
		expect(evalS('len("abc")')).toBe(3);
		expect(evalS('join(["a", "b"], "-")')).toBe('a-b');
		expect(evalS('join([1, 2, 3])')).toBe('1, 2, 3');
		expect(evalS('lower("ABC")')).toBe('abc');
		expect(evalS('upper("abc")')).toBe('ABC');
		expect(evalS('round(3.14159, 2)')).toBe(3.14);
		expect(evalS('round(-2.5, 0)')).toBe(-3);
	});

	it('today, date, days and fmt_date', async () => {
		await ctxFor();
		expect(valueToText(evalS('today()'))).toBe('2026-10-09');
		expect(evalS('days("2026-10-01", today())')).toBe(8);
		expect(evalS('days(today(), "2026-10-01")')).toBe(-8);
		expect(evalS('fmt_date(today(), "YYYY/MM/DD")')).toBe('2026/10/09');
		expect(evalS('fmt_date(date("2026-01-02"), "DD.MM.YYYY")')).toBe('02.01.2026');
		expect(evalS('fmt_date(date("2026-01-02"), "YYYY-WW")')).toBe('2026-WW'); // unknown letters are literal
	});

	it('link returns a link value', async () => {
		await ctxFor({ 'Server/Alpha.md': '---\ntags: [server]\n---\n# Alpha\n' });
		const v = evalS('link("Server/Alpha")') as Extract<Value, { kind: 'link' }>;
		expect(v.kind).toBe('link');
		expect(v.path).toBe('Server/Alpha');
		expect(v.label).toBe('Alpha');
		expect(renderValue(v)).toContain('href="/Server/Alpha"');
	});

	it('reads page records and frontmatter, with this = the current page', async () => {
		await ctxFor({ 'Query.md': '---\nstatus: offen\nbudget: 12\n---\n# Query\n' }, 'Query');
		expect(evalS('this.title')).toBe('Query');
		expect(evalS('this.path')).toBe('Query');
		expect(evalS('this.fm.status')).toBe('offen');
		expect(evalS('this.fm.budget + 3')).toBe(15);
		expect(evalS('this.fm.missing')).toBe(null);
		expect(evalS('this.fm.status ?? "offen"')).toBe('offen');
	});

	it('field access on null and missing fields yields null', async () => {
		await ctxFor();
		expect(evalS('page("Ghost").fm.x')).toBe(null);
		expect(evalS('page("Ghost").title')).toBe(null);
		expect(evalS('null.fm')).toBe(null);
		expect(evalS('this.fm.a.b.c')).toBe(null);
	});
});

// ---- security -------------------------------------------------------------------------

describe('security', () => {
	it('never reaches a JS prototype through field access', async () => {
		await ctxFor();
		for (const name of ['__proto__', 'constructor', 'prototype']) {
			expect(evalS(`this.fm.${name}`)).toBe(null);
			expect(evalS(`page("Ghost").${name}`)).toBe(null);
			expect(evalS(`{a: 1}.${name}`)).toBe(null);
		}
		// prototype pollution cannot happen either
		expect(evalS('this.fm.__proto__.polluted')).toBe(null);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});

	it('a __proto__ key in a query is an unrecognized key, not a prototype', async () => {
		await ctxFor({ 'Projects/A.md': '---\ntags: [project]\n---\nx\n', 'Query.md': '# Query\n' });
		expect(() => evalS('count({__proto__: {folder: "Projects"}})')).toThrow(/Unrecognized key|unrecognized/i);
		const { mdwiki } = await setup({ 'Projects/A.md': 'x\n', 'Query.md': '\n${count({__proto__: {folder: "X"}})}\n' });
		expect((await mdwiki.renderPage('Query'))!.html).toContain('class="chip error"');
	});

	it('link() cannot leave the origin', () => {
		for (const p of ['/evil.example', '//evil.example', '\\evil.example']) {
			const html = renderValue({ kind: 'link', path: p, label: 'x' });
			expect(html).toContain('href="/evil.example"');
			expect(html).not.toContain('href="//');
		}
	});

	it('escapes HTML in titles and frontmatter values', async () => {
		const html = `<img src=x onerror=alert(1)>`;
		await ctxFor({ 'Evil.md': `---\ntitle: "${html.replace(/"/g, '')}"\nnote: "<script>1</script>"\n---\nx\n`, 'Query.md': '# Query\n' });
		const title = renderValue(evalS('page("Evil").title'));
		const note = renderValue(evalS('page("Evil").fm.note'));
		expect(title).not.toContain('<img');
		expect(title).toContain('&lt;');
		expect(note).not.toContain('<script>');
		expect(note).toContain('&lt;script&gt;');
	});

	it('does not evaluate a frontmatter string that looks like ${...}', async () => {
		const { mdwiki } = await setup({ 'Query.md': '---\nfake: "${1 + 1}"\n---\n\nNachher: ${1 + 1}\n' });
		const v = (await mdwiki.renderPage('Query'))!;
		// the real expression in the body runs, the frontmatter string is only data
		expect(v.html).toContain('<p>Nachher: 2</p>');
		expect(v.frontmatter.fake).toBe('${1 + 1}');
	});

	it('does not replace an <!--expr:0--> written in the body', async () => {
		const { mdwiki } = await setup({ 'Query.md': 'Text with a fake placeholder <!--expr:0--> here.\n\n${1 + 2}\n' });
		const v = (await mdwiki.renderPage('Query'))!;
		// html:false escapes it, so it can never become a real placeholder
		expect(v.html).toContain('&lt;!--expr:0--&gt;');
		expect(v.html).not.toContain('<!--expr:0-->');
		expect(v.html).toContain('<p>3</p>');
	});
});

// ---- limits ---------------------------------------------------------------------------

describe('limits', () => {
	it('source text over 500 characters is a red error chip', async () => {
		const long = '1 + '.repeat(150) + '1';
		expect(long.length).toBeGreaterThan(MAX_EXPR_CHARS);
		const { mdwiki } = await setup({ 'Query.md': `\n\${${long}}\n` });
		const v = (await mdwiki.renderPage('Query'))!;
		expect(v.html).toContain('class="chip error"');
		expect(v.html).not.toContain('class="chip inert"');
	});

	it('AST depth over 32 is a red error chip', async () => {
		// right-nested so every level is a real AST level
		const deep = '1 + ('.repeat(40) + '1' + ')'.repeat(40);
		expect(() => parseExpr(deep)).toThrow(ExprRuntimeError);
		const { mdwiki } = await setup({ 'Query.md': `\n\${${deep}}\n` });
		const v = (await mdwiki.renderPage('Query'))!;
		expect(v.html).toContain('class="chip error"');
	});

	it('at most 50 expressions per page; the rest is a red chip', async () => {
		const body = Array.from({ length: 55 }, () => '${1}').join('\n\n');
		const { mdwiki } = await setup({ 'Query.md': `\n\n${body}\n` });
		const v = (await mdwiki.renderPage('Query'))!;
		expect(v.html).toContain(`limit ${MAX_EXPRS_PER_PAGE}`);
		expect(v.html.match(/<p>1<\/p>/g)!.length).toBe(MAX_EXPRS_PER_PAGE);
	});

	it('the step budget is enforced', async () => {
		await ctxFor();
		// build a wide AST directly: a source-level expression cannot reach 10000 steps within 500 chars
		const items: Node[] = Array.from({ length: MAX_STEPS + 10 }, () => ({ k: 'num', v: 1 }) as Node);
		const node: Node = { k: 'list', items };
		expect(() => evaluateNode(node, { index: ctx.index, self: ctx.self, budget: ctx.budget, now: ctx.now })).toThrow(/step limit/);
	});

	it('at most 20 engine queries per page, shared with pages blocks', async () => {
		const exprs = Array.from({ length: 25 }, () => '${count({tag: "server"})}').join(' ');
		const { mdwiki } = await setup({
			'Query.md': `\n${exprs}\n\n\`\`\`pages\ntag: server\nshow: count\n\`\`\`\n`,
			'Server/Alpha.md': '---\ntags: [server]\n---\nx\n'
		});
		const v = (await mdwiki.renderPage('Query'))!;
		expect(v.html).toContain(`query limit reached (${MAX_ENGINE_QUERIES} per page)`);
	});

	it('an intermediate string over 10000 characters is a runtime error', async () => {
		await ctxFor({ 'Query.md': `---\nbig: ${'x'.repeat(6000)}\n---\n# Query\n` });
		const big = 'this.fm.big';
		expect(() => evalS(`${big} + ${big}`)).toThrow(/string longer than 10000/);
		expect(() => evalS(`join([${big}, ${big}], "")`)).toThrow(/string longer than 10000/);
		expect(() => evalS(`len(${big} + ${big})`)).toThrow(/string longer than 10000/);
		expect(() => evalS(`fmt_date(today(), ${big} + ${big})`)).toThrow(/string longer than 10000/);
		expect(evalS(`len(upper(${big}))`)).toBe(6000);
	});

	it('a string result is capped at 10000 characters', async () => {
		const long = 'x'.repeat(MAX_STRING_CHARS + 500);
		expect((truncateStrings(long) as string).length).toBe(MAX_STRING_CHARS);
		expect(truncateStrings([long, 'ok'])).toEqual([long.slice(0, MAX_STRING_CHARS), 'ok']);
	});

	it('lists are capped by the pages query MAX_LIMIT', async () => {
		await ctxFor();
		expect(() => evalS('pages({tag: "server", limit: 100000})')).toThrow(ExprRuntimeError);
	});
});

// ---- robustness -----------------------------------------------------------------------

describe('robustness', () => {
	it('random inputs never throw out of the renderer', async () => {
		const { mdwiki } = await setup({ 'Query.md': '\n${1 + 1}\n' });
		const alphabet = 'abc123+-*/(){}[]<>=!&|?:.,"\'\\ $@#%^~`\n\t'.split('');
		for (let n = 0; n < 3000; n++) {
			let s = '';
			const len = 1 + Math.floor(Math.random() * 40);
			for (let i = 0; i < len; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
			try {
				parseExpr(s);
			} catch (e) {
				// the only acceptable failures are our own typed errors
				expect(e instanceof ExprParseError || e instanceof ExprRuntimeError).toBe(true);
			}
		}
		// and the page still renders
		expect((await mdwiki.renderPage('Query'))!.html).toContain('<p>2</p>');
	});

	it('random page content never throws out of the renderer', async () => {
		const alphabet = 'ab12+-*/()[]{}<>=!&|?:.,"\'\\ $@#%^~`\n\t'.split('');
		const files: Record<string, string> = {};
		for (let i = 0; i < 200; i++) {
			let s = '';
			for (let j = 0; j < 30; j++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
			files[`R/P${i}.md`] = `# r\n\n\${${s}}\n\n\${${s}}\n`;
		}
		const { mdwiki } = await setup(files);
		for (const p of mdwiki.index.list()) {
			const v = await mdwiki.renderPage(p.path);
			expect(v, p.path).not.toBeNull();
		}
	});

	it('a runtime error never blanks the page or aborts it', async () => {
		const { mdwiki } = await setup({ 'Query.md': '\nbefore\n\n${unknownName}\n\nafter\n' });
		const v = (await mdwiki.renderPage('Query'))!;
		expect(v.html).toContain('before');
		expect(v.html).toContain('after');
		expect(v.html).toContain('class="chip error"');
		expect(v.html).toContain('unknown name');
	});

	it('a parse failure stays a quiet chip', async () => {
		const { mdwiki } = await setup({ 'Query.md': '\n${1 +}\n' });
		const v = (await mdwiki.renderPage('Query'))!;
		expect(v.html).toContain('class="chip inert"');
		expect(v.html).not.toContain('class="chip error"');
	});
});

// ---- cache ----------------------------------------------------------------------------

describe('cache', () => {
	it('count() changes after a poll that adds a page', async () => {
		const { mdwiki, dir } = await setup({
			'Query.md': '\n${count({tag: "uniquecachetag"})}\n',
			'Cache/One.md': '---\ntags: [uniquecachetag]\n---\nx\n'
		});
		expect((await mdwiki.renderPage('Query'))!.html).toContain('<p>1</p>');
		fs.writeFileSync(path.join(dir, 'Cache/Two.md'), '---\ntags: [uniquecachetag]\n---\nx\n');
		await new Promise((r) => setTimeout(r, 450));
		expect((await mdwiki.renderPage('Query'))!.html).toContain('<p>2</p>');
	});

	it('keys the cache by day when today() is used', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			vi.setSystemTime(new Date('2026-10-09T12:00:00Z'));
			const { mdwiki } = await setup({ 'Query.md': '---\ndate: 2026-10-01\n---\n\n${days(this.fm.date, today())}\n' });
			expect(usesToday(parseExpr('days(this.fm.date, today())').node)).toBe(true);
			expect((await mdwiki.renderPage('Query'))!.html).toContain('<p>8</p>');
			// the same source on the next day must not serve the cached value
			vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
			expect((await mdwiki.renderPage('Query'))!.html).toContain('<p>9</p>');
		} finally {
			vi.useRealTimers();
		}
	});

	it('a page with only a quiet lua remnant keeps its cache key', async () => {
		const { mdwiki, dir } = await setup({ 'Quiet.md': '# Quiet\n\n${x = 1}\n' });
		const first = (await mdwiki.renderPage('Quiet'))!;
		expect(first.html).toContain('expression · not run');
		fs.writeFileSync(path.join(dir, 'Other.md'), '# Other\n');
		await mdwiki.index.refresh();
		await mdwiki.renderPage('Quiet');
		// quiet chips are not expressions: they neither take the 50 limit nor key the cache
		const many = Array.from({ length: 55 }, () => '${x = 1}').join('\n\n');
		fs.writeFileSync(path.join(dir, 'Many.md'), `\n${many}\n`);
		await mdwiki.index.refresh();
		expect((await mdwiki.renderPage('Many'))!.html).not.toContain('chip error');
	});

	it('a page without expressions keeps its cache key (no version bump needed)', async () => {
		const { mdwiki, dir } = await setup({ 'Plain.md': '# Plain\n\nno expressions here\n' });
		const first = (await mdwiki.renderPage('Plain'))!;
		// adding an unrelated page bumps index.version but must not change the plain page output
		fs.writeFileSync(path.join(dir, 'Other.md'), '# Other\n');
		await mdwiki.index.refresh();
		const second = (await mdwiki.renderPage('Plain'))!;
		expect(second.html).toBe(first.html);
	});
});

// ---- rendering and parity -------------------------------------------------------------

describe('rendering', () => {
	it('renders numbers, booleans, null, lists, records, pages and links', async () => {
		await ctxFor({
			'Server/Alpha.md': '---\ntags: [server]\ndate: 2026-10-01\n---\n# Alpha\n',
			'Query.md': '# Query\n'
		});
		expect(renderValue(evalS('2.5'))).toBe('2.5');
		expect(renderValue(evalS('1 / 3'))).toBe('<p>0.33</p>'.replace(/<\/?p>/g, '')); // rounded to 2 places as text
		expect(renderValue(evalS('false'))).toBe('false');
		expect(renderValue(evalS('null'))).toContain('expr-null');
		expect(renderValue(evalS('["a", "b"]'))).toBe('a, b');
		expect(renderValue(evalS('page("Server/Alpha")'))).toContain('wikilink');
		expect(renderValue(evalS('link("Server/Alpha", "Alias")'))).toContain('Alias');
		expect(renderValue(evalS('pages({tag: "server"})'))).toContain('wg-query wg-list');
	});

	it('evaluate returns the same text as the rendered page', async () => {
		const { mdwiki } = await setup({
			'Query.md': '\n${count({tag: "paritytag"})} / ${upper("ok")}\n',
			'Parity/One.md': '---\ntags: [paritytag]\n---\nx\n'
		});
		const rendered = (await mdwiki.renderPage('Query'))!;
		const counted = mdwiki.evaluateExpression('count({tag: "paritytag"})', 'Query');
		expect(counted.text).toBe('1');
		expect(rendered.html).toContain(`<p>${counted.text} / OK</p>`);
		const upper = mdwiki.evaluateExpression('upper("ok")', 'Query');
		expect(upper.text).toBe('OK');
	});

	it('evaluate reports a runtime failure as an error', async () => {
		const { mdwiki } = await setup();
		expect(() => mdwiki.evaluateExpression('unknownName')).toThrow(/unknown name/);
		expect(() => mdwiki.evaluateExpression('1/0')).toThrow(/division by zero/);
		expect(() => mdwiki.evaluateExpression(42 as never)).toThrow(/"expr" must be a string/);
		expect(() => mdwiki.evaluateExpression('1 + 1', 'Ghost/Page')).toThrow(/does not exist/);
	});
});

// ---- integration through the page -----------------------------------------------------

describe('page integration', () => {
	it('renders the four acceptance expressions on a page', async () => {
		const { mdwiki } = await setup({
			'Query.md':
				'---\nstatus: offen\ndate: 2026-10-01\n---\n\n' +
				'${count({tag: "accepttag"})}\n\n${this.fm.status ?? "offen"}\n\n${days(this.fm.date, today())}\n\n${sum(pages({folder: "AccProjects"}), "budget")}\n',
			'AccProjects/A.md': '---\ntags: [project]\nbudget: 100\n---\nx\n',
			'AccProjects/B.md': '---\ntags: [project]\nbudget: 250.5\n---\nx\n',
			'Accept/One.md': '---\ntags: [accepttag]\n---\nx\n'
		});
		const v = (await mdwiki.renderPage('Query'))!;
		expect(v.html).toContain('<p>1</p>'); // count of accepttag
		expect(v.html).toContain('<p>offen</p>'); // status
		expect(v.html).toContain('<p>350.5</p>'); // sum budget
		expect(v.html).not.toContain('chip error');
	});

	it('a page list alone in its paragraph is not wrapped in <p>', async () => {
		const { mdwiki } = await setup({
			'Query.md': '\n${pages({tag: "listtag"})}\n',
			'L/One.md': '---\ntags: [listtag]\n---\nx\n'
		});
		const html = (await mdwiki.renderPage('Query'))!.html;
		expect(html).toContain('wg-list');
		expect(html).not.toMatch(/<p>\s*<div/);
	});

	it('does not run expressions inside a fenced code block', async () => {
		const { mdwiki } = await setup({ 'Query.md': '```\n${1 + 1}\n```\n' });
		const v = (await mdwiki.renderPage('Query'))!;
		expect(v.html).toContain('${1 + 1}');
	});
});
