/**
 * Small unified-diff helper for the revision history. Myers' greedy algorithm on lines,
 * with a size guard: for huge inputs the diff degrades to "all old lines removed, all new
 * lines added" instead of spending quadratic time.
 */

export interface DiffResult {
	diff: string;
	added: number;
	removed: number;
	/** true when the size guard skipped the real line diff */
	truncated: boolean;
}

type Op = { type: ' ' | '-' | '+'; text: string };

const MAX_TOTAL_LINES = 20_000;

function splitLines(text: string): string[] {
	if (text === '') return [];
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	if (lines[lines.length - 1] === '') lines.pop();
	return lines;
}

function replaceAll(a: string[], b: string[]): Op[] {
	return [...a.map((text) => ({ type: '-' as const, text })), ...b.map((text) => ({ type: '+' as const, text }))];
}

function myers(a: string[], b: string[]): Op[] {
	const n = a.length;
	const m = b.length;
	if (n === 0) return b.map((text) => ({ type: '+' as const, text }));
	if (m === 0) return a.map((text) => ({ type: '-' as const, text }));
	const max = n + m;
	const off = max;
	const v = new Int32Array(2 * max + 3);
	const trace: Int32Array[] = [];
	for (let d = 0; d <= max; d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x: number;
			if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
			else x = v[off + k - 1] + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[off + k] = x;
			if (x >= n && y >= m) return backtrack(trace, a, b, d, off);
		}
	}
	return [];
}

function backtrack(trace: Int32Array[], a: string[], b: string[], d: number, off: number): Op[] {
	const ops: Op[] = [];
	let x = a.length;
	let y = b.length;
	for (let depth = d; depth > 0; depth--) {
		const v = trace[depth];
		const k = x - y;
		const prevK = k === -depth || (k !== depth && v[off + k - 1] < v[off + k + 1]) ? k + 1 : k - 1;
		const prevX = v[off + prevK];
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) ops.push({ type: ' ', text: a[--x] }), y--;
		if (depth > 0) {
			if (x === prevX) ops.push({ type: '+', text: b[--y] });
			else ops.push({ type: '-', text: a[--x] });
		}
	}
	while (x > 0 && y > 0) ops.push({ type: ' ', text: a[--x] }), y--;
	while (x > 0) ops.push({ type: '-', text: a[--x] });
	while (y > 0) ops.push({ type: '+', text: b[--y] });
	return ops.reverse();
}

export interface ChangeStats {
	added: number;
	removed: number;
	bytesAdded: number;
	bytesRemoved: number;
}

/** Line and byte counts of a change, used for the revision record. */
export function changeStats(oldText: string, newText: string): ChangeStats {
	const a = splitLines(oldText);
	const b = splitLines(newText);
	const ops = a.length + b.length > MAX_TOTAL_LINES ? replaceAll(a, b) : myers(a, b);
	const stats: ChangeStats = { added: 0, removed: 0, bytesAdded: 0, bytesRemoved: 0 };
	for (const op of ops) {
		// every stored line counts with its newline; the last line may lack one
		const bytes = Buffer.byteLength(op.text, 'utf8') + 1;
		if (op.type === '+') {
			stats.added++;
			stats.bytesAdded += bytes;
		} else if (op.type === '-') {
			stats.removed++;
			stats.bytesRemoved += bytes;
		}
	}
	return stats;
}

/** Unified diff with three lines of context. Labels appear in the `---`/`+++` header. */
export function unifiedDiff(oldText: string, newText: string, oldLabel: string, newLabel: string, context = 3): DiffResult {
	const a = splitLines(oldText);
	const b = splitLines(newText);
	const truncated = a.length + b.length > MAX_TOTAL_LINES;
	const ops = truncated ? replaceAll(a, b) : myers(a, b);
	let added = 0;
	let removed = 0;
	for (const op of ops) {
		if (op.type === '+') added++;
		else if (op.type === '-') removed++;
	}
	// line numbers before each op, in the old and the new file
	const positions: { oldLine: number; newLine: number }[] = [];
	let oldLine = 1;
	let newLine = 1;
	for (const op of ops) {
		positions.push({ oldLine, newLine });
		if (op.type === ' ') oldLine++, newLine++;
		else if (op.type === '-') oldLine++;
		else newLine++;
	}
	const changed = ops.map((op, i) => (op.type === ' ' ? -1 : i)).filter((i) => i >= 0);
	const out: string[] = [`--- ${oldLabel}`, `+++ ${newLabel}`];
	if (!changed.length) return { diff: '', added, removed, truncated };
	let start = Math.max(0, changed[0] - context);
	let end = Math.min(ops.length - 1, changed[0] + context);
	for (const index of changed.slice(1)) {
		if (index - context <= end + 1) end = Math.min(ops.length - 1, index + context);
		else {
			out.push(...hunk(ops, positions, start, end));
			start = Math.max(0, index - context);
			end = Math.min(ops.length - 1, index + context);
		}
	}
	out.push(...hunk(ops, positions, start, end));
	return { diff: out.join('\n') + '\n', added, removed, truncated };
}

function hunk(ops: Op[], positions: { oldLine: number; newLine: number }[], start: number, end: number): string[] {
	const oldCount = ops.slice(start, end + 1).filter((o) => o.type !== '+').length;
	const newCount = ops.slice(start, end + 1).filter((o) => o.type !== '-').length;
	const oldStart = oldCount ? positions[start].oldLine : positions[start].oldLine - 1;
	const newStart = newCount ? positions[start].newLine : positions[start].newLine - 1;
	const out = [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`];
	for (const op of ops.slice(start, end + 1)) out.push(op.type + op.text);
	return out;
}
