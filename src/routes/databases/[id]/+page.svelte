<script lang="ts">
	import { BRAND } from '#lib/brand';
	import { page as appPage } from '$app/state';
	import type { CollectionSummary, Property } from '#lib/server/collections';

	let { data } = $props();
	const db = $derived(data.collection as CollectionSummary);
	const fields = $derived(data.collection.properties as Property[]);
	const visible = $derived(fields.filter((p: Property) => (data.columns as string[]).includes(p.name)));

	function hrefWith(changes: Record<string, string | null>): string {
		const url = new URL(appPage.url.href);
		for (const [key, value] of Object.entries(changes)) {
			if (value === null) url.searchParams.delete(key);
			else url.searchParams.set(key, value);
		}
		return url.pathname + (url.searchParams.size ? `?${url.searchParams}` : '');
	}

	function sortHref(name: string): string {
		const current = data.sorts[0];
		const next = current && current.property === name && current.direction === 'asc' ? 'desc' : 'asc';
		const url = new URL(appPage.url.href);
		url.searchParams.set('sort', `${name}:${next}`);
		url.searchParams.delete('offset');
		return url.pathname + (url.searchParams.size ? `?${url.searchParams}` : '');
	}

	function sortMark(name: string): string {
		const current = data.sorts[0];
		if (!current || current.property !== name) return '';
		return current.direction === 'asc' ? '↑' : '↓';
	}

	function viewHref(id: string): string {
		return id ? `/databases/${db.id}?view=${encodeURIComponent(id)}` : `/databases/${db.id}`;
	}

	function cellText(value: unknown): string {
		if (value === null || value === undefined || value === '') return '—';
		if (typeof value === 'boolean') return value ? '✓' : '—';
		if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
		if (typeof value === 'number') return value.toLocaleString('de-DE');
		return String(value);
	}

	function filterValue(index: number, key: 'op' | 'value'): string {
		const filter = data.filters[index];
		if (!filter) return key === 'op' ? 'contains' : '';
		return key === 'op' ? filter.op : String(filter.value ?? '');
	}

	const first = $derived(data.total === 0 ? 0 : data.offset + 1);
	const last = $derived(Math.min(data.offset + data.rows.length, data.total));
</script>

<svelte:head><title>{db.name} · {BRAND}</title></svelte:head>

<article class="page database">
	<header class="db-head">
		<div>
			<p class="eyebrow"><a href="/databases">Databases</a> / {db.properties.length} properties</p>
			<h1><span class="db-icon" aria-hidden="true">{db.icon ?? '▦'}</span>{db.name}</h1>
		</div>
		<p class="db-count">{data.total} {data.total === 1 ? 'row' : 'rows'}</p>
	</header>

	<nav class="views" aria-label="Views">
		<a class:active={!data.view} href={viewHref('')}>All</a>
		{#each data.views as view (view.id)}
			<a class:active={data.view === view.id} href={viewHref(view.id)}>{view.name}</a>
		{/each}
	</nav>

	<form class="filters" method="get">
		{#if data.view}<input type="hidden" name="view" value={data.view} />{/if}
		{#each [0, 1, 2] as i}
			<div class="filter-row">
				<select name="p{i}" aria-label="Filter property {i + 1}">
					<option value="">Filter…</option>
					{#each fields as prop (prop.id)}
						<option value={prop.name} selected={data.filters[i]?.property === prop.name}>{prop.name}</option>
					{/each}
				</select>
				<select name="o{i}" aria-label="Filter operator {i + 1}">
					{#each data.ops as op (op)}
						<option value={op} selected={filterValue(i, 'op') === op}>{op.replaceAll('_', ' ')}</option>
					{/each}
				</select>
				<input name="v{i}" value={filterValue(i, 'value')} placeholder="value" aria-label="Filter value {i + 1}" />
			</div>
		{/each}
		<div class="filter-actions">
			<button class="btn small primary" type="submit">Apply filters</button>
			<a class="btn small" href={viewHref(data.view)}>Clear</a>
		</div>
	</form>

	<div class="table-wrap">
		<table>
			<thead>
				<tr>
					{#each visible as prop (prop.id)}
						<th scope="col">
							<a href={sortHref(prop.name)} title="Sort by {prop.name}">{prop.name} <span class="sort-mark">{sortMark(prop.name)}</span></a>
						</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each data.rows as row (row.id)}
					<tr>
						{#each visible as prop (prop.id)}
							{@const value = row.values[prop.name]}
							<td class="cell type-{prop.type}">
								{#if prop.type === 'checkbox'}
									<span class:checked={value === true}>{value === true ? '✓' : '—'}</span>
								{:else if prop.type === 'select' && value}
									<span class="chip">{cellText(value)}</span>
								{:else if prop.type === 'multi_select' && Array.isArray(value) && value.length}
									<span class="chips">{#each value as v (v)}<span class="chip">{v}</span>{/each}</span>
								{:else if prop.type === 'url' && value}
									<a href={String(value)} target="_blank" rel="noopener noreferrer">{String(value).replace(/^https?:\/\//, '')}</a>
								{:else if prop.type === 'email' && value}
									<a href="mailto:{String(value)}">{String(value)}</a>
								{:else if prop.type === 'title'}
									<strong>{cellText(value)}</strong>
								{:else}
									{cellText(value)}
								{/if}
							</td>
						{/each}
					</tr>
				{:else}
					<tr><td class="empty" colspan={visible.length}>No rows match.</td></tr>
				{/each}
			</tbody>
		</table>
	</div>

	<footer class="pager">
		<span class="muted">{first}–{last} of {data.total}</span>
		{#if data.offset > 0}
			<a class="btn small" href={hrefWith({ offset: String(Math.max(data.offset - data.limit, 0)) })}>Previous</a>
		{/if}
		{#if data.offset + data.limit < data.total}
			<a class="btn small" href={hrefWith({ offset: String(data.offset + data.limit) })}>Next</a>
		{/if}
	</footer>
</article>

<style>
	.database { max-width: 100%; }
	.db-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
	.eyebrow { margin: 0; font: 700 0.72rem var(--mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }
	.eyebrow a { color: inherit; }
	.db-head h1 { margin: 0.15rem 0 0.6rem; display: flex; align-items: center; gap: 0.5rem; }
	.db-icon { font-size: 1.1rem; }
	.db-count { margin: 0 0 0.7rem; color: var(--muted); font: 0.8rem var(--mono); }
	.views { display: flex; gap: 0.25rem; flex-wrap: wrap; border-bottom: 1px solid var(--border); margin-bottom: 0.8rem; }
	.views a { padding: 0.35rem 0.7rem; color: var(--muted); border-bottom: 2px solid transparent; margin-bottom: -1px; }
	.views a:hover { color: var(--fg); text-decoration: none; }
	.views a.active { color: var(--fg); border-bottom-color: var(--accent); font-weight: 700; }
	.filters { display: grid; gap: 0.5rem; margin: 0 0 1rem; }
	.filter-row { display: grid; grid-template-columns: minmax(8rem, 1fr) minmax(7rem, 0.8fr) minmax(8rem, 1.2fr); gap: 0.4rem; }
	.filters select, .filters input { width: 100%; min-height: 34px; padding: 0.3rem 0.5rem; color: var(--fg); background: var(--panel); border: 1px solid var(--border); border-radius: 6px; font: inherit; }
	.filter-actions { display: flex; gap: 0.4rem; }
	.table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
	table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
	th, td { text-align: left; padding: 0.45rem 0.7rem; border-bottom: 1px solid var(--border); vertical-align: top; }
	th { position: sticky; top: 0; background: var(--panel); font: 700 0.72rem var(--mono); text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); white-space: nowrap; z-index: 1; }
	th a { color: inherit; }
	tr:hover td { background: color-mix(in srgb, var(--fg) 4%, transparent); }
	.type-number { text-align: right; font-variant-numeric: tabular-nums; }
	.type-title { min-width: 12rem; }
	.type-text { min-width: 14rem; max-width: 32rem; }
	.cell .chip { display: inline-block; border: 1px solid var(--border); border-radius: 999px; padding: 0 7px; margin: 1px 2px 1px 0; font-size: 0.78rem; color: var(--muted); }
	.cell .chips { display: inline-flex; flex-wrap: wrap; gap: 2px; }
	.checkbox .checked, .type-checkbox .checked { color: var(--hl-string); font-weight: 700; }
	.empty { text-align: center; color: var(--muted); padding: 1.4rem; }
	.pager { display: flex; gap: 0.5rem; align-items: center; margin-top: 0.8rem; }
</style>
