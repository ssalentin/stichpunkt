import type { PropertyType } from './collections';

/**
 * Read-only helpers for migrating Markdown tables into collections. The parser is deliberately
 * conservative: it reports what it sees and guesses only unambiguous types. A migration is a
 * separate, explicit step because a wrong guess would silently change the data.
 */

export interface ParsedTable {
	/** 1-based position of the table within the page */
	index: number;
	/** nearest heading above the table, or null */
	heading: string | null;
	columns: string[];
	rows: string[][];
	/** line number of the header row (1-based) */
	line: number;
}

export interface InferredColumn {
	name: string;
	type: PropertyType;
}

export interface TablePreview {
	index: number;
	name: string;
	columns: InferredColumn[];
	rows: string[][];
	rowCount: number;
}

function splitRow(line: string): string[] {
	const cells: string[] = [];
	let current = '';
	let escaped = false;
	let inCode = false;
	for (const char of line.trim().replace(/^\|/, '').replace(/\|$/, '')) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === '\\') {
			escaped = true;
			continue;
		}
		if (char === '`') inCode = !inCode;
		if (char === '|' && !inCode) {
			cells.push(current.trim());
			current = '';
			continue;
		}
		current += char;
	}
	cells.push(current.trim());
	return cells;
}

const isDivider = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);

/** All pipe tables in a Markdown body. Fenced code blocks are ignored. */
export function parseMarkdownTables(body: string): ParsedTable[] {
	const lines = body.split(/\r?\n/);
	const out: ParsedTable[] = [];
	let heading: string | null = null;
	let fence: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
		if (fenceMatch) {
			if (fence === null) fence = fenceMatch[1][0];
			else if (fenceMatch[1][0] === fence) fence = null;
			continue;
		}
		if (fence) continue;
		const h = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
		if (h) {
			heading = h[1].replace(/[*_`]/g, '').trim();
			continue;
		}
		if (!/^\s*\|/.test(line) || !isDivider(lines[i + 1] ?? '')) continue;
		const columns = splitRow(line);
		const rows: string[][] = [];
		let j = i + 2;
		while (j < lines.length && /^\s*\|/.test(lines[j])) {
			rows.push(splitRow(lines[j]));
			j++;
		}
		out.push({ index: out.length + 1, heading, columns, rows, line: i + 1 });
		i = j - 1;
	}
	return out;
}

function inferColumn(name: string, values: string[], isFirst: boolean): PropertyType {
	const filled = values.map((v) => v.trim()).filter((v) => v !== '' && v !== '—' && v !== '-');
	if (isFirst) return 'title';
	if (filled.length && filled.every((v) => /^(true|false)$/i.test(v))) return 'checkbox';
	if (filled.length && filled.every((v) => /^-?\d+([.,]\d+)?$/.test(v.replace(/\s/g, '')))) return 'number';
	if (filled.length && filled.every((v) => /^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(v))) return 'date';
	if (/\b(url|link|website)\b/i.test(name) && filled.every((v) => /^https?:\/\//.test(v))) return 'url';
	if (/\b(e-?mail)\b/i.test(name) && filled.every((v) => /^[^@\s]+@[^@\s]+$/.test(v))) return 'email';
	return 'text';
}

/** A preview of what a table would become; no writes. */
export function previewTable(page: string, table: ParsedTable): TablePreview {
	const columns = table.columns.map((name, i) => ({
		name: name || `Spalte ${i + 1}`,
		type: inferColumn(name, table.rows.map((r) => r[i] ?? ''), i === 0)
	}));
	const name = table.heading ? `${page} · ${table.heading}` : `${page} · Tabelle ${table.index}`;
	return { index: table.index, name, columns, rows: table.rows, rowCount: table.rows.length };
}
