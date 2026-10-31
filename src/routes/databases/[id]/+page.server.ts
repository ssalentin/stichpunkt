import { fail, redirect } from '@sveltejs/kit';
import { getCollections } from '#lib/server/collection-service';
import { collectionWriteEnabled, collectionWriteRefusal } from '#lib/server/collection-write';
import { CollectionError, type Filter, type Property, type Sort } from '#lib/server/collections';
import { MdwikiError } from '#lib/server/errors';
import type { Actions, PageServerLoad } from './$types';

const OPS = ['eq', 'neq', 'contains', 'not_contains', 'starts_with', 'ends_with', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty'] as const;
const MAX_FORM_BYTES = 512 * 1024;

export const load: PageServerLoad = async ({ params, url }) => {
	const store = getCollections();
	const collection = store.get(params.id);
	const views = store.views(params.id);
	const view = url.searchParams.get('view') ?? '';
	const filters: Filter[] = [];
	for (let i = 0; i < 3; i++) {
		const property = url.searchParams.get(`p${i}`)?.trim();
		const op = url.searchParams.get(`o${i}`) ?? 'contains';
		const value = url.searchParams.get(`v${i}`) ?? '';
		if (!property) continue;
		filters.push({ property, op: op as Filter['op'], value: op === 'is_empty' || op === 'is_not_empty' ? undefined : value });
	}
	const sortParam = url.searchParams.get('sort') ?? '';
	const sorts: Sort[] = [];
	if (sortParam.includes(':')) {
		const [property, direction] = sortParam.split(':');
		sorts.push({ property, direction: direction === 'desc' ? 'desc' : 'asc' });
	}
	const selected = views.find((v) => v.id === view);
	const effectiveFilters = filters.length ? filters : (selected?.filters ?? []);
	const effectiveSorts = sorts.length ? sorts : (selected?.sorts ?? []);
	const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500);
	const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
	const result = store.query(params.id, { filters: effectiveFilters, sorts: effectiveSorts, limit, offset });
	const columns = selected?.columns?.length ? selected.columns : collection.properties.map((p) => p.name);
	const editId = url.searchParams.get('edit') ?? '';
	const creating = url.searchParams.get('new') === '1';
	let editing = null;
	if (editId) {
		try {
			editing = store.getRow(params.id, editId);
		} catch {
			editing = null;
		}
	}
	return {
		collection,
		views,
		view,
		columns,
		filters: effectiveFilters,
		sorts: effectiveSorts,
		ops: OPS,
		limit,
		offset,
		rows: result.rows,
		total: result.total,
		canEdit: collectionWriteEnabled(),
		editing,
		creating,
		saved: url.searchParams.get('saved') === '1'
	};
};

function valuesFromForm(form: FormData, properties: Property[]): Record<string, unknown> {
	const values: Record<string, unknown> = {};
	for (const prop of properties) {
		const raw = form.getAll(`p:${prop.name}`).map((v) => String(v));
		if (prop.type === 'checkbox') values[prop.name] = raw.includes('1');
		else if (prop.type === 'multi_select') values[prop.name] = raw.filter((v) => v !== '');
		else values[prop.name] = raw.length ? raw[raw.length - 1] : '';
	}
	return values;
}

function formTooLarge(form: FormData): boolean {
	let total = 0;
	for (const [, value] of form.entries()) {
		total += typeof value === 'string' ? value.length : value.size;
		if (total > MAX_FORM_BYTES) return true;
	}
	return false;
}

export const actions: Actions = {
	save: async ({ request, params, url }) => {
		const refusal = collectionWriteRefusal(request.headers);
		if (refusal) return fail(403, { error: refusal });
		const form = await request.formData();
		if (formTooLarge(form)) return fail(413, { error: 'The row is too large.' });
		const store = getCollections();
		const collection = store.get(params.id);
		const rowId = String(form.get('row_id') ?? '');
		const values = valuesFromForm(form, collection.properties);
		try {
			if (rowId) {
				const base = String(form.get('base_updated_at') ?? '');
				if (!base) return fail(400, { error: 'Missing row version. Reload and try again.' });
				store.updateRow(params.id, rowId, values, 'web-ui', base);
			} else {
				store.createRow(params.id, values, 'web-ui');
			}
		} catch (e) {
			if (e instanceof MdwikiError) {
				return fail(e.status === 409 ? 409 : 400, {
					error: e.status === 409 ? 'This row changed while you were editing. Reload and merge your changes.' : e.message
				});
			}
			throw e;
		}
		throw redirect(303, withFlag(url, 'saved'));
	},
	delete: async ({ request, params, url }) => {
		const refusal = collectionWriteRefusal(request.headers);
		if (refusal) return fail(403, { error: refusal });
		const form = await request.formData();
		const rowId = String(form.get('row_id') ?? '');
		if (!rowId) return fail(400, { error: 'Missing row.' });
		try {
			getCollections().deleteRow(params.id, rowId, 'web-ui');
		} catch (e) {
			if (e instanceof CollectionError) return fail(e.status, { error: e.message });
			throw e;
		}
		throw redirect(303, withFlag(url, 'saved'));
	}
};

/** Keep view/filter/sort, drop the editor state, add the confirmation flag. */
function withFlag(url: URL, flag: string): string {
	const next = new URL(url);
	next.searchParams.delete('edit');
	next.searchParams.delete('new');
	next.searchParams.set(flag, '1');
	return next.pathname + next.search;
}
