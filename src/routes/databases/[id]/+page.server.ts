import { getCollections } from '#lib/server/collection-service';
import type { Filter, Sort } from '#lib/server/collections';
import type { PageServerLoad } from './$types';

const OPS = ['eq', 'neq', 'contains', 'not_contains', 'starts_with', 'ends_with', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty'] as const;

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
		total: result.total
	};
};
