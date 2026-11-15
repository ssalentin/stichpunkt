import type { Property } from '#lib/server/collections';

/**
 * Group-key logic shared by the database page's server load and its template. It mirrors the
 * store's SQL expression: the raw stored cell value; dates truncated to the day; checkboxes
 * 'true'/'false'; multi_select the exact stored JSON combination; empty and missing cells the
 * null key. Keys cross the URL in the `collapsed` parameter, each key percent-encoded once and
 * joined by commas, so keys containing commas survive.
 */

/** Sentinel for the null group key in the `collapsed` parameter. */
export const EMPTY_GROUP_KEY = '__empty__';

/** The UI-side mirror of the store's group key expression. */
export function groupKeyOf(prop: Property, value: unknown): string | null {
	if (value === null || value === undefined || value === '') return null;
	if (prop.type === 'date') return String(value).slice(0, 10);
	if (prop.type === 'checkbox') return String(value === true || value === 'true');
	if (prop.type === 'multi_select') return Array.isArray(value) && value.length > 0 ? JSON.stringify(value.map(String)) : null;
	return String(value);
}

/** Wire form of the collapsed list: every key encoded once, joined by commas. */
export function collapsedParam(keys: string[]): string {
	return keys.map(encodeURIComponent).join(',');
}

/** Toggle one key in the collapsed list; returns the wire form, or null to drop the param. */
export function toggleCollapsedKey(collapsed: string[], key: string | null): string | null {
	const sentinel = key ?? EMPTY_GROUP_KEY;
	const next = collapsed.includes(sentinel) ? collapsed.filter((c) => c !== sentinel) : [...collapsed, sentinel];
	return next.length ? collapsedParam(next) : null;
}

/** Read the `collapsed` query param back into decoded keys, sentinel included. */
export function parseCollapsedParam(raw: string | null): string[] {
	if (!raw) return [];
	const out: string[] = [];
	for (const part of raw.split(',').filter((s) => s !== '')) {
		let key = part;
		try {
			key = decodeURIComponent(part);
		} catch {
			/* malformed escape: the raw value wins */
		}
		if (!out.includes(key)) out.push(key);
	}
	return out;
}
