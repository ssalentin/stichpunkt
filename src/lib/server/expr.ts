import { escapeHtml } from './markdown';
import { parsePagesQuery, runPagesQuery, type PagesResult, type PagesRow } from './pages-query';
import type { PageRec, SpaceIndex } from './space';

/**
 * A small, total expression language for `${ ... }`. It is a Pratt parser plus a tree-walking
 * evaluator, both written here. Nothing is executed: no `eval`, no `new Function`, no `node:vm`
 * and no evaluator dependency. The language has no loops, no user functions and no assignment,
 * so every expression terminates. Values are a private union type; records are `Map`s, so there
 * is no JS property lookup and `__proto__` / `constructor` / `prototype` are unreachable. The
 * only way to touch the space is through the whitelisted builtins, which read the index through
 * the same engine as the `pages` block.
 */

// ---- limits (all enforced, each has a test) -------------------------------------------

/** Source text of one `${...}` may not exceed this many characters (excluding the delimiters). */
export const MAX_EXPR_CHARS = 500;
/** At most this many expressions per page. */
export const MAX_EXPRS_PER_PAGE = 50;
/** AST depth, counted inclusively from the root (root = 1). */
export const MAX_AST_DEPTH = 32;
/** Evaluation steps (nodes visited) per expression. */
export const MAX_STEPS = 10_000;
/** Engine queries per page, shared with `pages` blocks (counted by the render context). */
export const MAX_ENGINE_QUERIES = 20;
/** A string result is truncated to this many characters. */
export const MAX_STRING_CHARS = 10_000;

/** Raised for a value that parses but cannot be evaluated; becomes the red error chip. */
export class ExprRuntimeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ExprRuntimeError';
	}
}

/** Raised while parsing; a parse failure keeps the quiet chip (never a red one). */
export class ExprParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ExprParseError';
	}
}

/** The per-page budget shared by all expressions and `pages` blocks on one render. */
export class QueryBudget {
	used = 0;
	constructor(readonly max = MAX_ENGINE_QUERIES) {}
	take(): void {
		if (this.used >= this.max) throw new ExprRuntimeError(`query limit reached (${this.max} per page)`);
		this.used++;
	}
}

// ---- values ---------------------------------------------------------------------------

export interface PageValue {
	kind: 'page';
	path: string;
	title: string;
	folder: string;
	tags: string[];
	date: string;
	modified: string;
	fm: Map<string, Value>;
}

export interface LinkValue {
	kind: 'link';
	path: string;
	label: string;
}

/** A `Date` tagged as an expression value so date-typed builtins stay distinguishable. */
export class ExprDate extends Date {}

export type Value = null | boolean | number | string | Value[] | { rec: Map<string, Value> } | PageValue | LinkValue | ExprDate;

// ---- AST ------------------------------------------------------------------------------

export type Node =
	| { k: 'num'; v: number }
	| { k: 'str'; v: string }
	| { k: 'bool'; v: boolean }
	| { k: 'null' }
	| { k: 'list'; items: Node[] }
	| { k: 'obj'; entries: { key: string; value: Node }[] }
	| { k: 'this' }
	| { k: 'name'; name: string }
	| { k: 'un'; op: '-' | 'not'; e: Node }
	| { k: 'bin'; op: string; l: Node; r: Node }
	| { k: 'cond'; c: Node; a: Node; b: Node }
	| { k: 'field'; obj: Node; name: string }
	| { k: 'call'; callee: Node; args: Node[] };

// ---- tokenizer ------------------------------------------------------------------------

type TokType = 'num' | 'str' | 'name' | 'punct';
interface Token {
	t: TokType;
	v: string;
}

const PUNCT = ['==', '!=', '<=', '>=', '??', '&&', '||', '+', '-', '*', '/', '%', '<', '>', '(', ')', '[', ']', '{', '}', ',', '.', ':', '?'];

class Lexer {
	pos = 0;
	constructor(readonly src: string) {}

	next(): Token | null {
		const s = this.src;
		while (this.pos < s.length && /\s/.test(s[this.pos])) this.pos++;
		if (this.pos >= s.length) return null;
		const start = this.pos;
		const c = s[this.pos];
		if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[this.pos + 1] ?? ''))) {
			let i = this.pos;
			while (i < s.length && /[0-9]/.test(s[i])) i++;
			if (s[i] === '.') {
				i++;
				while (i < s.length && /[0-9]/.test(s[i])) i++;
			}
			if (/[eE]/.test(s[i] ?? '')) {
				let j = i + 1;
				if (/[+-]/.test(s[j] ?? '')) j++;
				if (/[0-9]/.test(s[j] ?? '')) {
					i = j;
					while (i < s.length && /[0-9]/.test(s[i])) i++;
				}
			}
			this.pos = i;
			return { t: 'num', v: s.slice(start, i) };
		}
		if (c === '"' || c === "'") {
			let out = '';
			let i = this.pos + 1;
			for (; i < s.length; i++) {
				const ch = s[i];
				if (ch === '\\') {
					const nxt = s[i + 1];
					const map: Record<string, string> = { '"': '"', "'": "'", '\\': '\\', n: '\n' };
					if (nxt === undefined || !(nxt in map)) throw new ExprParseError(`unknown escape \\${nxt ?? ''}`);
					out += map[nxt];
					i++;
				} else if (ch === c) {
					this.pos = i + 1;
					return { t: 'str', v: out };
				} else out += ch;
			}
			throw new ExprParseError('unterminated string');
		}
		if (/[A-Za-z_]/.test(c)) {
			let i = this.pos;
			while (i < s.length && /[A-Za-z0-9_-]/.test(s[i])) i++;
			this.pos = i;
			return { t: 'name', v: s.slice(start, i) };
		}
		for (const p of PUNCT) {
			if (s.startsWith(p, this.pos)) {
				this.pos += p.length;
				return { t: 'punct', v: p };
			}
		}
		throw new ExprParseError(`unexpected character ${JSON.stringify(c)}`);
	}
}

// ---- parser ---------------------------------------------------------------------------

class Parser {
	private toks: Token[];
	private i = 0;
	constructor(src: string) {
		const lex = new Lexer(src);
		this.toks = [];
		for (let t = lex.next(); t; t = lex.next()) this.toks.push(t);
	}

	private peek(): Token | null {
		return this.toks[this.i] ?? null;
	}
	private at(off: number): Token | null {
		return this.toks[this.i + off] ?? null;
	}
	private isPunct(v: string, off = 0): boolean {
		const t = this.at(off);
		return !!t && t.t === 'punct' && t.v === v;
	}
	private eat(v: string): boolean {
		if (this.isPunct(v)) {
			this.i++;
			return true;
		}
		return false;
	}
	private expect(v: string): void {
		if (!this.eat(v)) throw new ExprParseError(`expected "${v}"`);
	}
	private advance(): Token {
		const t = this.toks[this.i];
		if (!t) throw new ExprParseError('unexpected end of input');
		this.i++;
		return t;
	}

	parse(): Node {
		const node = this.expression(0);
		if (this.i < this.toks.length) throw new ExprParseError('unexpected trailing input');
		return node;
	}

	/** Binding power of the next infix/postfix token (0 = stop). */
	private bindingPower(): number {
		const t = this.peek();
		if (!t) return 0;
		if (t.t === 'punct') {
			switch (t.v) {
				case '?':
					return 2;
				case '??':
					return 3;
				case '.':
					return 15; // field access binds tighter than any operator
				case '*':
				case '/':
				case '%':
					return 13;
				case '+':
				case '-':
					return 12;
				case '==':
				case '!=':
				case '<':
				case '<=':
				case '>':
				case '>=':
					return 8;
				default:
					return 0;
			}
		}
		if (t.t === 'name') {
			if (t.v === 'or' || t.v === '||') return 4;
			if (t.v === 'and' || t.v === '&&') return 5;
		}
		return 0;
	}

	private expression(minBp: number): Node {
		let left = this.postfix(this.nud());
		for (;;) {
			const bp = this.bindingPower();
			if (bp <= minBp) break;
			const tk = this.peek()!;
			if (tk.t === 'punct' && tk.v === '?') {
				this.i++;
				const a = this.expression(0);
				this.expect(':');
				const b = this.expression(1);
				left = this.postfix({ k: 'cond', c: left, a, b });
				continue;
			}
			if (tk.t === 'punct' && tk.v === '.') {
				this.i++;
				const name = this.advance();
				if (name.t !== 'name' && name.t !== 'str') throw new ExprParseError('field name expected after "."');
				left = this.postfix({ k: 'field', obj: left, name: name.v });
				continue;
			}
			this.i++;
			const op = tk.v;
			// `??` is right-associative; the rest are left-associative at their level
			const r = this.expression(op === '??' ? bp - 1 : bp);
			left = { k: 'bin', op, l: left, r };
		}
		return left;
	}

	/** Applies any immediately following `(...)` calls to an already-parsed callee. */
	private postfix(left: Node): Node {
		while (this.isPunct('(')) {
			this.i++;
			const args: Node[] = [];
			if (!this.isPunct(')')) {
				args.push(this.expression(0));
				while (this.eat(',')) {
					if (this.isPunct(')')) break;
					args.push(this.expression(0));
				}
			}
			this.expect(')');
			left = { k: 'call', callee: left, args };
		}
		return left;
	}

	private nud(): Node {
		const t = this.advance();
		if (t.t === 'num') {
			const v = Number(t.v);
			if (!Number.isFinite(v)) throw new ExprParseError(`invalid number ${t.v}`);
			return { k: 'num', v };
		}
		if (t.t === 'str') return { k: 'str', v: t.v };
		if (t.t === 'name') {
			if (t.v === 'true') return { k: 'bool', v: true };
			if (t.v === 'false') return { k: 'bool', v: false };
			if (t.v === 'null') return { k: 'null' };
			if (t.v === 'this') return { k: 'this' };
			if (t.v === 'not') return { k: 'un', op: 'not', e: this.expression(6) };
			if (t.v === 'and' || t.v === 'or' || t.v === '&&' || t.v === '||') throw new ExprParseError(`unexpected "${t.v}"`);
			return { k: 'name', name: t.v };
		}
		switch (t.v) {
			case '-':
				return { k: 'un', op: '-', e: this.expression(14) };
			case '(': {
				const e = this.expression(0);
				this.expect(')');
				return e;
			}
			case '[': {
				const items: Node[] = [];
				if (!this.isPunct(']')) {
					items.push(this.expression(0));
					while (this.eat(',')) {
						if (this.isPunct(']')) break;
						items.push(this.expression(0));
					}
				}
				this.expect(']');
				return { k: 'list', items };
			}
			case '{': {
				const entries: { key: string; value: Node }[] = [];
				if (!this.isPunct('}')) {
					for (;;) {
						const keyTok = this.advance();
						if (keyTok.t !== 'str' && keyTok.t !== 'name') throw new ExprParseError('object keys must be identifiers or strings');
						this.expect(':');
						entries.push({ key: keyTok.v, value: this.expression(0) });
						if (!this.eat(',')) break;
						if (this.isPunct('}')) break;
					}
				}
				this.expect('}');
				return { k: 'obj', entries };
			}
			default:
				throw new ExprParseError(`unexpected token ${JSON.stringify(t.v)}`);
		}
	}
}

export function parseExpression(src: string): Node {
	return new Parser(src).parse();
}

// ---- evaluator context ----------------------------------------------------------------

export interface EvalContext {
	index: SpaceIndex;
	self: string;
	budget: QueryBudget;
	now: Date;
}

interface Machine {
	steps: number;
	ctx: EvalContext;
}

const isMap = (v: Value): v is { rec: Map<string, Value> } => typeof v === 'object' && v !== null && (v as { rec?: unknown }).rec instanceof Map;
const isPageValue = (v: Value): v is PageValue => typeof v === 'object' && v !== null && (v as PageValue).kind === 'page';
const isLinkValue = (v: Value): v is LinkValue => typeof v === 'object' && v !== null && (v as LinkValue).kind === 'link';

const truthy = (v: Value): boolean => {
	if (v === null || v === false) return false;
	if (v === true) return true;
	if (typeof v === 'number') return v !== 0;
	if (typeof v === 'string') return v !== '';
	if (Array.isArray(v)) return v.length > 0;
	return true;
};

/** Field access. Never touches a JS prototype; `null` for a missing field or a non-record. */
function fieldGet(v: Value, name: string): Value {
	if (v === null || v === undefined) return null;
	if (isMap(v)) {
		const got = v.rec.get(name);
		return got === undefined ? null : got;
	}
	if (Array.isArray(v)) return name === 'length' ? v.length : null;
	if (isPageValue(v)) {
		switch (name) {
			case 'path':
				return v.path;
			case 'title':
				return v.title;
			case 'folder':
				return v.folder;
			case 'tags':
				return v.tags;
			case 'date':
				return v.date;
			case 'modified':
				return v.modified;
			case 'fm':
				return { rec: v.fm };
			default:
				return null;
		}
	}
	return null;
}

const folderOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const dateStr = (fm: Record<string, unknown>) => (fm.date == null ? '' : String(fm.date));

function toPageValue(rec: PageRec): PageValue {
	const fm = new Map<string, Value>();
	for (const [k, val] of Object.entries(rec.frontmatter)) fm.set(k, toPlainValue(val));
	return {
		kind: 'page',
		path: rec.path,
		title: rec.title,
		folder: folderOf(rec.path),
		tags: rec.tags,
		date: dateStr(rec.frontmatter),
		modified: new Date(rec.mtimeMs).toISOString(),
		fm
	};
}

/** Converts an index frontmatter value into an expression value (objects/arrays stay useful). */
export function toPlainValue(v: unknown): Value {
	if (v == null) return null;
	if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') return v;
	if (Array.isArray(v)) return v.map(toPlainValue);
	if (typeof v === 'object') {
		const map = new Map<string, Value>();
		for (const [k, val] of Object.entries(v as Record<string, unknown>)) map.set(k, toPlainValue(val));
		return { rec: map };
	}
	return String(v);
}

// ---- builtins -------------------------------------------------------------------------

function num(v: Value, what: string): number {
	if (typeof v !== 'number' || !Number.isFinite(v)) throw new ExprRuntimeError(`${what} expects a number`);
	return v;
}

function requireString(v: Value, what: string): string {
	if (typeof v !== 'string') throw new ExprRuntimeError(`${what} expects a string`);
	return v;
}

/** Rounds without `toFixed` surprises on negatives. */
function roundTo(x: number, n: number): number {
	const f = 10 ** n;
	return (Math.sign(x) * Math.round(Math.abs(x) * f)) / f;
}

const dateOf = (v: Value, what: string): Date => {
	if (v instanceof Date) return v;
	if (typeof v === 'string') {
		const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
		if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
		const d = new Date(v);
		if (!Number.isNaN(d.getTime())) return d;
	}
	if (typeof v === 'number') return new Date(v);
	throw new ExprRuntimeError(`${what} expects a date or an ISO string`);
};

/** A page record's field: a reserved record field, else a frontmatter key, else null. */
function pageField(p: PageValue, field: string): Value {
	switch (field) {
		case 'path':
		case 'title':
		case 'folder':
		case 'tags':
		case 'date':
		case 'modified':
			return fieldGet(p, field);
		case 'fm':
			return { rec: p.fm };
		default: {
			const got = p.fm.get(field);
			return got === undefined ? null : got;
		}
	}
}

function listItems(v: Value, what: string): Value[] {
	if (Array.isArray(v)) return v;
	throw new ExprRuntimeError(`${what} expects a list`);
}

/** Plain text of a scalar value, used by `join` (records become their path or a placeholder). */
function scalarText(v: Value): string {
	if (v === null) return '';
	if (typeof v === 'boolean') return v ? 'true' : 'false';
	if (typeof v === 'number') return String(v);
	if (typeof v === 'string') return v;
	if (isPageValue(v)) return v.path;
	if (isLinkValue(v)) return v.path;
	return '';
}

/** Numeric projection over `field`; non-numbers, numeric strings and nulls are handled predictably. */
function projectNumbers(items: Value[], field: string): number[] {
	const out: number[] = [];
	for (const item of items) {
		let raw: Value;
		if (typeof item === 'number' || typeof item === 'string') raw = item;
		else if (isPageValue(item)) raw = pageField(item, field);
		else if (isMap(item)) {
			const got = item.rec.get(field);
			raw = got === undefined ? null : got;
		} else raw = null; // values that are not a number, page or record are skipped
		if (typeof raw === 'number' && Number.isFinite(raw)) out.push(raw);
		else if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) out.push(Number(raw));
	}
	return out;
}

function callBuiltin(name: string, args: Value[], m: Machine): Value {
	const arity = (n: number, max = n) => {
		if (args.length < n || args.length > max) throw new ExprRuntimeError(`${name} takes ${n === max ? n : `${n}–${max}`} argument(s)`);
	};
	switch (name) {
		case 'pages': {
			arity(1);
			if (!isMap(args[0])) throw new ExprRuntimeError('pages expects a query object');
			return runQuery(args[0], m)
				.rows.map((row) => {
					const rec = m.ctx.index.get(row.path);
					return rec ? toPageValue(rec) : null;
				})
				.filter((x): x is PageValue => x !== null);
		}
		case 'count': {
			arity(1);
			if (!isMap(args[0])) throw new ExprRuntimeError('count expects a query object');
			return runQuery(args[0], m).total;
		}
		case 'page': {
			arity(1);
			const target = requireString(args[0], 'page path');
			const resolved = m.ctx.index.resolve(target, m.ctx.self) ?? target;
			const rec = m.ctx.index.get(resolved);
			return rec ? toPageValue(rec) : null;
		}
		case 'sum':
		case 'min':
		case 'max':
		case 'avg': {
			arity(1, 2);
			const items = listItems(args[0], name);
			const nums = projectNumbers(items, args.length === 2 ? requireString(args[1], `${name} field`) : '');
			if (name === 'sum') return nums.reduce((a, b) => a + b, 0);
			if (!nums.length) return null;
			if (name === 'min') return Math.min(...nums);
			if (name === 'max') return Math.max(...nums);
			return nums.reduce((a, b) => a + b, 0) / nums.length;
		}
		case 'len': {
			arity(1);
			if (Array.isArray(args[0])) return args[0].length;
			if (typeof args[0] === 'string') return args[0].length;
			throw new ExprRuntimeError('len expects a list or a string');
		}
		case 'join': {
			arity(1, 2);
			const items = listItems(args[0], 'join');
			const sep = args.length === 2 ? requireString(args[1], 'join separator') : ', ';
			return items.map((x) => scalarText(x)).join(sep);
		}
		case 'lower':
			arity(1);
			return requireString(args[0], 'lower').toLowerCase();
		case 'upper':
			arity(1);
			return requireString(args[0], 'upper').toUpperCase();
		case 'round':
			arity(2);
			return roundTo(num(args[0], 'round'), num(args[1], 'round digits'));
		case 'today':
			arity(0);
			return new ExprDate(Date.UTC(m.ctx.now.getUTCFullYear(), m.ctx.now.getUTCMonth(), m.ctx.now.getUTCDate()));
		case 'date':
			arity(1);
			return new ExprDate(dateOf(args[0], 'date').getTime());
		case 'days': {
			arity(2);
			const a = dateOf(args[0], 'days');
			const b = dateOf(args[1], 'days');
			return Math.round((b.getTime() - a.getTime()) / 86_400_000);
		}
		case 'fmt_date': {
			arity(2);
			const d = dateOf(args[0], 'fmt_date');
			const raw = requireString(args[1], 'fmt_date pattern');
			if (/[YMD]/.test(raw.replace(/YYYY|MM|DD/g, ''))) throw new ExprRuntimeError('fmt_date pattern knows only YYYY, MM and DD');
			return raw
				.replace(/YYYY/g, String(d.getUTCFullYear()).padStart(4, '0'))
				.replace(/MM/g, String(d.getUTCMonth() + 1).padStart(2, '0'))
				.replace(/DD/g, String(d.getUTCDate()).padStart(2, '0'));
		}
		case 'link': {
			arity(1, 2);
			const path = requireString(args[0], 'link path');
			const label = args.length === 2 ? requireString(args[1], 'link label') : path.slice(path.lastIndexOf('/') + 1);
			const resolved = m.ctx.index.resolve(path, m.ctx.self);
			return { kind: 'link', path: resolved ?? path, label } satisfies LinkValue;
		}
		default:
			throw new ExprRuntimeError(`unknown function "${name}"`);
	}
}

function runQuery(q: { rec: Map<string, Value> }, m: Machine): PagesResult {
	const raw: Record<string, unknown> = {};
	for (const [k, v] of q.rec.entries()) raw[k] = toRaw(v, m.ctx.self);
	let parsed;
	try {
		parsed = parsePagesQuery(raw);
	} catch (e) {
		throw new ExprRuntimeError((e as Error).message);
	}
	m.ctx.budget.take();
	return runPagesQuery(m.ctx.index, parsed, m.ctx.self);
}

/**
 * Converts an expression value back to the plain JS shape the query schema expects. A page value
 * that is the current page becomes the literal `this`, so `folder: this` / `links-to: this` work
 * exactly as in a `pages` block.
 */
function toRaw(v: Value, self = ''): unknown {
	if (v === null || typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') return v;
	if (Array.isArray(v)) return v.map((x) => toRaw(x, self));
	if (isMap(v)) {
		const obj: Record<string, unknown> = {};
		for (const [k, val] of v.rec.entries()) obj[k] = toRaw(val, self);
		return obj;
	}
	if (isPageValue(v)) return self && v.path === self ? 'this' : v.path;
	if (isLinkValue(v)) return v.path;
	return null;
}

export const KNOWN_BUILTINS = new Set([
	'pages',
	'count',
	'page',
	'sum',
	'min',
	'max',
	'avg',
	'len',
	'join',
	'lower',
	'upper',
	'round',
	'today',
	'date',
	'days',
	'fmt_date',
	'link'
]);

// ---- evaluator core -------------------------------------------------------------------

function evalNode(node: Node, m: Machine): Value {
	if (++m.steps > MAX_STEPS) throw new ExprRuntimeError(`step limit reached (${MAX_STEPS})`);
	switch (node.k) {
		case 'num':
		case 'str':
		case 'bool':
			return node.v;
		case 'null':
			return null;
		case 'list':
			return node.items.map((n) => evalNode(n, m));
		case 'obj': {
			const map = new Map<string, Value>();
			for (const e of node.entries) map.set(e.key, evalNode(e.value, m));
			return { rec: map };
		}
		case 'this': {
			const rec = m.ctx.index.get(m.ctx.self);
			return rec ? toPageValue(rec) : null;
		}
		case 'name':
			throw new ExprRuntimeError(`unknown name "${node.name}"`);
		case 'un': {
			const v = evalNode(node.e, m);
			if (node.op === '-') return -num(v, 'unary "-"');
			return !truthy(v);
		}
		case 'bin':
			return evalBinary(node, m);
		case 'cond':
			return truthy(evalNode(node.c, m)) ? evalNode(node.a, m) : evalNode(node.b, m);
		case 'field':
			return fieldGet(evalNode(node.obj, m), node.name);
		case 'call': {
			if (node.callee.k === 'field') throw new ExprRuntimeError('method calls are not supported');
			if (node.callee.k !== 'name') throw new ExprRuntimeError('this is not callable');
			const name = node.callee.name;
			if (!KNOWN_BUILTINS.has(name)) throw new ExprRuntimeError(`unknown function "${name}"`);
			return callBuiltin(name, node.args.map((a) => evalNode(a, m)), m);
		}
	}
}

function evalBinary(node: Extract<Node, { k: 'bin' }>, m: Machine): Value {
	const op = node.op;
	if (op === 'and' || op === '&&') {
		const l = evalNode(node.l, m);
		return truthy(l) ? evalNode(node.r, m) : l;
	}
	if (op === 'or' || op === '||') {
		const l = evalNode(node.l, m);
		return truthy(l) ? l : evalNode(node.r, m);
	}
	if (op === '??') {
		const l = evalNode(node.l, m);
		return l === null ? evalNode(node.r, m) : l;
	}
	const l = evalNode(node.l, m);
	const r = evalNode(node.r, m);
	switch (op) {
		case '+':
			if (typeof l === 'number' && typeof r === 'number') return l + r;
			if (typeof l === 'string' && typeof r === 'string') return l + r;
			throw new ExprRuntimeError('"+" needs two numbers or two strings');
		case '-':
			return num(l, '-') - num(r, '-');
		case '*':
			return num(l, '*') * num(r, '*');
		case '/':
			return num(l, '/') / divGuard(r);
		case '%':
			return num(l, '%') % divGuard(r);
		case '==':
			return equals(l, r);
		case '!=':
			return !equals(l, r);
		case '<':
			return compare(l, r) < 0;
		case '<=':
			return compare(l, r) <= 0;
		case '>':
			return compare(l, r) > 0;
		case '>=':
			return compare(l, r) >= 0;
		default:
			throw new ExprRuntimeError(`unsupported operator "${op}"`);
	}
}

function divGuard(v: Value): number {
	const d = num(v, '/');
	if (d === 0) throw new ExprRuntimeError('division by zero');
	return d;
}

function equals(a: Value, b: Value): boolean {
	if (typeof a === 'number' && typeof b === 'number') return a === b;
	if (typeof a === 'string' && typeof b === 'string') return a === b;
	if (typeof a === 'boolean' && typeof b === 'boolean') return a === b;
	if (a === null && b === null) return true;
	if (isLinkValue(a) && isLinkValue(b)) return a.path === b.path && a.label === b.label;
	if (isPageValue(a) && isPageValue(b)) return a.path === b.path;
	return a === b;
}

function compare(a: Value, b: Value): number {
	if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
	if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
	throw new ExprRuntimeError('comparison needs two numbers or two strings');
}

// ---- AST helpers ----------------------------------------------------------------------

function depthOf(node: Node, depth = 1): number {
	let max = depth;
	const walk = (n: Node) => {
		max = Math.max(max, depthOf(n, depth + 1));
	};
	switch (node.k) {
		case 'list':
			node.items.forEach(walk);
			break;
		case 'obj':
			node.entries.forEach((e) => walk(e.value));
			break;
		case 'un':
			walk(node.e);
			break;
		case 'bin':
			walk(node.l);
			walk(node.r);
			break;
		case 'cond':
			walk(node.c);
			walk(node.a);
			walk(node.b);
			break;
		case 'field':
			walk(node.obj);
			break;
		case 'call':
			walk(node.callee);
			node.args.forEach(walk);
			break;
		default:
			break;
	}
	return max;
}

/** True when the AST calls `today()` anywhere (used to key the render cache by day). */
export function usesToday(node: Node): boolean {
	switch (node.k) {
		case 'call':
			return (node.callee.k === 'name' && node.callee.name === 'today') || usesToday(node.callee) || node.args.some(usesToday);
		case 'list':
			return node.items.some(usesToday);
		case 'obj':
			return node.entries.some((e) => usesToday(e.value));
		case 'un':
			return usesToday(node.e);
		case 'bin':
			return usesToday(node.l) || usesToday(node.r);
		case 'cond':
			return usesToday(node.c) || usesToday(node.a) || usesToday(node.b);
		case 'field':
			return usesToday(node.obj);
		default:
			return false;
	}
}

// ---- public API -----------------------------------------------------------------------

export interface ParsedExpr {
	node: Node;
	usesToday: boolean;
}

/**
 * Parses one expression body. Throws {@link ExprParseError} for anything not in the language,
 * and {@link ExprRuntimeError} for an over-long source or too-deep nesting. Those long/deep
 * cases become the red error chip; a plain parse failure stays the quiet chip.
 */
export function parseExpr(src: string): ParsedExpr {
	if (src.length > MAX_EXPR_CHARS) throw new ExprRuntimeError(`expression is longer than ${MAX_EXPR_CHARS} characters`);
	if (src.trim() === '') throw new ExprParseError('empty expression');
	const node = parseExpression(src);
	if (depthOf(node) > MAX_AST_DEPTH) throw new ExprRuntimeError(`expression nesting is deeper than ${MAX_AST_DEPTH}`);
	return { node, usesToday: usesToday(node) };
}

/** Evaluates an already parsed expression. Throws {@link ExprRuntimeError} on any runtime failure. */
export function evaluateNode(node: Node, ctx: EvalContext): Value {
	const m: Machine = { steps: 0, ctx };
	return truncateStrings(evalNode(node, m));
}

/** Full evaluate entry point: parse then run. Throws on parse or runtime failure. */
export function evaluate(src: string, ctx: EvalContext): Value {
	return evaluateNode(parseExpr(src).node, ctx);
}

/** Caps every string inside a value at {@link MAX_STRING_CHARS}. */
export function truncateStrings(v: Value): Value {
	if (typeof v === 'string') return v.length > MAX_STRING_CHARS ? v.slice(0, MAX_STRING_CHARS) : v;
	if (Array.isArray(v)) return v.map(truncateStrings);
	return v;
}
