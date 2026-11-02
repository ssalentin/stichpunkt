<script lang="ts">
	import { BRAND } from '#lib/brand';
	import { page as appPage } from '$app/state';
	import type { CollectionSummary, Property } from '#lib/server/collections';

	let { data, form } = $props();
	const db = $derived(data.collection as CollectionSummary);
	const fields = $derived(data.collection.properties as Property[]);
	const visible = $derived(fields.filter((p: Property) => (data.columns as string[]).includes(p.name)));

	const closeHref = $derived(hrefWith({ edit: null, new: null, saved: null }));

	function editHref(rowId: string): string {
		return hrefWith({ edit: rowId, new: null, saved: null });
	}

	function fieldValue(prop: Property, row: { values: Record<string, unknown> } | null): string {
		const value = row?.values[prop.name];
		if (value === null || value === undefined) return '';
		if (prop.type === 'date') return String(value).slice(0, 10);
		return String(value);
	}

	function listValue(prop: Property, row: { values: Record<string, unknown> } | null): string[] {
		const value = row?.values[prop.name];
		return Array.isArray(value) ? value.map(String) : [];
	}

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

	// the title property labels a card; a view may hide it, so fall back to the first visible column
	const titleProp = $derived(visible.find((p: Property) => p.type === 'title') ?? visible[0]);
	const cardFields = $derived(visible.filter((p: Property) => p.id !== titleProp?.id));
	const currentSort = $derived(data.sorts[0] ? `${data.sorts[0].property}:${data.sorts[0].direction}` : '');
</script>

{#snippet cell(prop: Property, value: unknown)}
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
	{:else}
		{cellText(value)}
	{/if}
{/snippet}

<svelte:head><title>{db.name} · {BRAND}</title></svelte:head>

<article class="page database">
	<header class="db-head">
		<div>
			<p class="eyebrow"><a href="/databases">Databases</a> / {db.properties.length} properties</p>
			<h1><span class="db-icon" aria-hidden="true">{db.icon ?? '▦'}</span>{db.name}</h1>
		</div>
		<div class="head-actions">
			{#if data.canEdit}<a class="btn small primary" href={hrefWith({ new: '1', edit: null, saved: null })}>New row</a>{/if}
			<p class="db-count">{data.total} {data.total === 1 ? 'row' : 'rows'}</p>
		</div>
	</header>

	<nav class="views" aria-label="Views">
		<a class:active={!data.view} href={viewHref('')}>All</a>
		{#each data.views as view (view.id)}
			<a class:active={data.view === view.id} href={viewHref(view.id)}>{view.name}</a>
		{/each}
	</nav>

	{#if data.saved}
		<p class="notice ok" role="status">Saved.</p>
	{/if}
	{#if form?.error}
		<p class="notice bad" role="alert">{form.error}</p>
	{/if}

	{#if data.canEdit && (data.creating || data.editing)}
		<section class="editor" aria-label={data.editing ? 'Edit row' : 'New row'}>
			<h2>{data.editing ? 'Edit row' : 'New row'}</h2>
			<form method="post" action="?/save">
				<input type="hidden" name="row_id" value={data.editing?.id ?? ''} />
				{#if data.editing}<input type="hidden" name="base_updated_at" value={data.editing.updated_at} />{/if}
				<div class="fields">
					{#each fields as prop (prop.id)}
						<label class="field">
							<span>{prop.name}</span>
							{#if prop.type === 'checkbox'}
								<input type="hidden" name="p:{prop.name}" value="0" />
								<input type="checkbox" name="p:{prop.name}" value="1" checked={data.editing?.values[prop.name] === true} />
							{:else if prop.type === 'select'}
								<select name="p:{prop.name}">
									<option value="">—</option>
									{#each prop.options ?? [] as option (option)}
										<option value={option} selected={fieldValue(prop, data.editing) === option}>{option}</option>
									{/each}
								</select>
							{:else if prop.type === 'multi_select'}
								<span class="multi">
									{#each prop.options ?? [] as option (option)}
										<label class="check">
											<input type="checkbox" name="p:{prop.name}" value={option} checked={listValue(prop, data.editing).includes(option)} />
											{option}
										</label>
									{/each}
								</span>
							{:else if prop.type === 'number'}
								<input type="number" step="any" name="p:{prop.name}" value={fieldValue(prop, data.editing)} />
							{:else if prop.type === 'date'}
								<input type="date" name="p:{prop.name}" value={fieldValue(prop, data.editing)} />
							{:else if prop.type === 'url'}
								<input type="url" name="p:{prop.name}" value={fieldValue(prop, data.editing)} />
							{:else if prop.type === 'email'}
								<input type="email" name="p:{prop.name}" value={fieldValue(prop, data.editing)} />
							{:else}
								<input type="text" name="p:{prop.name}" value={fieldValue(prop, data.editing)} />
							{/if}
						</label>
					{/each}
				</div>
				<div class="editor-actions">
					<button class="btn small primary" type="submit">Save</button>
					<a class="btn small" href={closeHref}>Cancel</a>
					{#if data.editing}
						<button
							class="btn small danger"
							type="submit"
							formaction="?/delete"
							onclick={() => confirm('Delete this row?')}>Delete</button>
					{/if}
				</div>
			</form>
		</section>
	{/if}

	<form class="filters" method="get">
		{#if data.view}<input type="hidden" name="view" value={data.view} />{/if}
		{#if currentSort}<input type="hidden" name="sort" value={currentSort} />{/if}
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
							{#if prop.id === titleProp?.id}
								<th scope="row" class="cell type-{prop.type}">
									<span class="title-cell">
										<strong>{cellText(value)}</strong>
										{#if data.canEdit}<a class="edit-link" href={editHref(row.id)}>Edit</a>{/if}
									</span>
								</th>
							{:else}
								<td class="cell type-{prop.type}">
									{@render cell(prop, value)}
								</td>
							{/if}
						{/each}
					</tr>
				{:else}
					<tr><td class="empty" colspan={visible.length}>No rows match.</td></tr>
				{/each}
			</tbody>
		</table>
	</div>

	<form class="card-sort" method="get" aria-label="Sort rows">
		{#if data.view}<input type="hidden" name="view" value={data.view} />{/if}
		{#each data.filters as filter, i (i)}
			<input type="hidden" name="p{i}" value={filter.property} />
			<input type="hidden" name="o{i}" value={filter.op} />
			<input type="hidden" name="v{i}" value={String(filter.value ?? '')} />
		{/each}
		<label for="card-sort">Sort</label>
		<select id="card-sort" name="sort">
			<option value="" selected={!currentSort}>Default</option>
			{#each fields as prop (prop.id)}
				<option value="{prop.name}:asc" selected={currentSort === `${prop.name}:asc`}>{prop.name} ↑</option>
				<option value="{prop.name}:desc" selected={currentSort === `${prop.name}:desc`}>{prop.name} ↓</option>
			{/each}
		</select>
		<button class="btn small" type="submit">Apply</button>
	</form>

	<ul class="cards">
		{#each data.rows as row (row.id)}
			<li class="card">
				<div class="card-head">
					<span class="card-title">{titleProp ? cellText(row.values[titleProp.name]) : '—'}</span>
					{#if data.canEdit}<a class="btn small" href={editHref(row.id)}>Edit</a>{/if}
				</div>
				<dl class="card-fields">
					{#each cardFields as prop (prop.id)}
						<div class="card-field">
							<dt>{prop.name}</dt>
							<dd class="type-{prop.type}">{@render cell(prop, row.values[prop.name])}</dd>
						</div>
					{/each}
				</dl>
			</li>
		{:else}
			<li class="card empty">No rows match.</li>
		{/each}
	</ul>

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
	tbody th { position: static; z-index: auto; background: none; font: inherit; text-transform: none; letter-spacing: normal; white-space: normal; color: var(--fg); }
	tbody th a { color: var(--link); }
	.database :is(a, button, select, input):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
	tbody tr:hover :is(td, th) { background: color-mix(in srgb, var(--fg) 4%, transparent); }
	.type-number { text-align: right; font-variant-numeric: tabular-nums; }
	.type-title { min-width: 12rem; }
	.type-text { min-width: 14rem; max-width: 32rem; }
	.chip { display: inline-block; border: 1px solid var(--border); border-radius: 999px; padding: 0 7px; margin: 1px 2px 1px 0; font-size: 0.78rem; color: var(--muted); }
	.chips { display: inline-flex; flex-wrap: wrap; gap: 2px; }
	.checkbox .checked, .type-checkbox .checked { color: var(--hl-string); font-weight: 700; }
	.empty { text-align: center; color: var(--muted); padding: 1.4rem; }
	.card-sort, .cards { display: none; }
	.pager { display: flex; gap: 0.5rem; align-items: center; margin-top: 0.8rem; }
	.head-actions { display: flex; align-items: center; gap: 0.7rem; margin-bottom: 0.7rem; }
	.db-count { margin: 0; }
	.notice { padding: 0.55rem 0.8rem; border-left: 3px solid var(--accent); background: var(--panel); margin: 0 0 0.8rem; }
	.notice.ok { border-left-color: var(--hl-string); }
	.notice.bad { border-left-color: var(--danger); }
	.editor { border: 1px solid var(--border); border-radius: 8px; background: var(--panel); padding: 0.8rem 0.9rem; margin: 0 0 1rem; }
	.editor h2 { margin: 0 0 0.6rem; font-size: 0.8rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
	.fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 0.6rem 0.8rem; }
	.field { display: flex; flex-direction: column; gap: 0.2rem; min-width: 0; }
	.field > span { font: 700 0.7rem var(--mono); text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
	.field input[type='text'], .field input[type='number'], .field input[type='date'], .field input[type='url'], .field input[type='email'], .field select {
		width: 100%; min-height: 34px; padding: 0.3rem 0.5rem; color: var(--fg); background: var(--bg); border: 1px solid var(--border); border-radius: 6px; font: inherit;
	}
	.field .multi { display: flex; flex-wrap: wrap; gap: 0.35rem 0.8rem; min-height: 34px; align-items: center; }
	.field .check { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.85rem; }
	.field input[type='checkbox'] { width: 16px; height: 16px; accent-color: var(--accent); }
	.editor-actions { display: flex; gap: 0.4rem; margin-top: 0.8rem; flex-wrap: wrap; }
	.title-cell { display: inline-flex; align-items: baseline; gap: 0.6rem; }
	.edit-link { font-size: 0.72rem; color: var(--muted); opacity: 0; }
	tr:hover .edit-link, .edit-link:focus-visible { opacity: 1; }
	@media (hover: none) { .edit-link { opacity: 1; } }

	/* Under 640px a card list replaces the table; filters and sort stay the same server-side query. */
	@media (max-width: 639px) {
		.db-head { align-items: flex-start; }
		.head-actions { margin-bottom: 0.3rem; }
		.filter-row { grid-template-columns: minmax(0, 1fr); }
		.filter-actions .btn { flex: 1; justify-content: center; }
		.table-wrap { display: none; }
		.cards { display: grid; gap: 0.55rem; list-style: none; margin: 0; padding: 0; }
		.card { border: 1px solid var(--border); border-radius: 8px; background: var(--panel); padding: 0.6rem 0.7rem; }
		.card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; }
		.card-title { min-width: 0; font-weight: 700; overflow-wrap: anywhere; }
		.card-fields { display: grid; gap: 0.3rem; margin: 0.45rem 0 0; }
		.card-field { display: grid; grid-template-columns: minmax(5rem, 34%) minmax(0, 1fr); gap: 0.4rem; }
		.card-field dt { padding-top: 0.1rem; color: var(--muted); font: 700 0.68rem var(--mono); letter-spacing: 0.04em; text-transform: uppercase; overflow-wrap: anywhere; }
		.card-field dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
		.card-field dd.type-number { text-align: right; }
		.card-sort { display: flex; align-items: center; gap: 0.4rem; margin: 0 0 0.7rem; }
		.card-sort label { color: var(--muted); font: 700 0.72rem var(--mono); letter-spacing: 0.05em; text-transform: uppercase; }
		.card-sort select { flex: 1; min-width: 0; min-height: 34px; padding: 0.3rem 0.5rem; color: var(--fg); background: var(--panel); border: 1px solid var(--border); border-radius: 6px; font: inherit; }
	}
</style>
