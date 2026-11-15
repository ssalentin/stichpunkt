<script lang="ts">
	import { BRAND } from '#lib/brand';
	import { page as appPage } from '$app/state';
	import { EMPTY_GROUP_KEY, collapsedParam, groupKeyOf, toggleCollapsedKey } from '#lib/group-key';
	import type { CollectionSummary, GroupInfo, Property, RowRecord } from '#lib/server/collections';

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

	const groupProp = $derived.by((): Property | null => {
		const name = data.group as string;
		if (!name || !data.groups) return null;
		return fields.find((p: Property) => p.name.toLowerCase() === name.toLowerCase()) ?? null;
	});

	interface GroupSection {
		key: string | null;
		count: number;
		collapsed: boolean;
		rows: RowRecord[];
	}

	/**
	 * One section per group from the store, in order, with the page's rows bucketed under their
	 * key. Rows whose JS key matches no SQL key (exotic stored forms) get their own section at
	 * the end. Collapsed groups have no rows: the load already hid them.
	 */
	const sections = $derived.by((): GroupSection[] | null => {
		const groups = data.groups as GroupInfo[] | null;
		const prop = groupProp;
		if (!groups || !prop) return null;
		const collapsed = new Set<string>(data.collapsed as string[]);
		const out: GroupSection[] = groups.map((g) => ({
			key: g.key,
			count: g.count,
			collapsed: collapsed.has(g.key ?? EMPTY_GROUP_KEY),
			rows: []
		}));
		const byKey = new Map<string, GroupSection>(out.map((s) => [s.key ?? EMPTY_GROUP_KEY, s]));
		for (const row of data.rows as RowRecord[]) {
			const key = groupKeyOf(prop, row.values[prop.name]) ?? EMPTY_GROUP_KEY;
			const section = byKey.get(key);
			if (!section) {
				const leftover: GroupSection = { key: key === EMPTY_GROUP_KEY ? null : key, count: 1, collapsed: false, rows: [row] };
				byKey.set(key, leftover);
				out.push(leftover);
				continue;
			}
			section.rows.push(row);
		}
		return out;
	});

	function groupLabel(section: GroupSection): string {
		if (section.key === null) return '(empty)';
		if (groupProp?.type === 'multi_select' && section.key.startsWith('[')) {
			try {
				const parsed: unknown = JSON.parse(section.key);
				if (Array.isArray(parsed)) return parsed.map(String).join(', ');
			} catch {
				/* the raw stored key wins */
			}
		}
		return section.key;
	}

	/** The footer value for one visible column, or '' when the column has no aggregate. */
	function aggregateText(prop: Property): string {
		const aggs = data.aggregates as Record<string, { fn: string; value: unknown }> | null;
		if (!aggs) return '';
		const key = Object.keys(aggs).find((k) => k.toLowerCase() === prop.name.toLowerCase());
		const entry = key ? aggs[key] : undefined;
		if (!entry) return '';
		if (entry.value === null || entry.value === undefined) return '—';
		if (prop.type === 'date' && typeof entry.value === 'string') return cellText(entry.value.slice(0, 10));
		return cellText(entry.value);
	}

	// ---- bulk edit -----------------------------------------------------------------------
	/** Row ids ticked on this page; the panel form collects them through `form="bulk-form"`. */
	let selected = $state<Set<string>>(new Set());
	let bulkProp = $state('');

	/** A row that filter, sort or paging moved off the page leaves the selection with it. */
	$effect(() => {
		const onPage = new Set(data.rows.map((r: RowRecord) => r.id));
		if ([...selected].some((id) => !onPage.has(id))) selected = new Set([...selected].filter((id) => onPage.has(id)));
	});

	const selectedCount = $derived(selected.size);
	const allSelected = $derived(data.rows.length > 0 && data.rows.every((r: RowRecord) => selected.has(r.id)));
	/** Titles stay out of reach: a bulk change would rename the collection in one click. */
	const bulkProperties = $derived(fields.filter((p: Property) => p.type !== 'title'));

	function toggleRow(rowId: string, on: boolean): void {
		const next = new Set(selected);
		if (on) next.add(rowId);
		else next.delete(rowId);
		selected = next;
	}

	function toggleAllRows(on: boolean): void {
		const ids = data.rows.map((r: RowRecord) => r.id);
		selected = on ? new Set([...selected, ...ids]) : new Set([...selected].filter((id) => !ids.includes(id)));
	}

	function bulkLabel(row: RowRecord): string {
		return titleProp ? cellText(row.values[titleProp.name]) : row.id;
	}

	/** The panel is opened by a link (`?bulk=1`) so it works without JS; the click upgrades it. */
	let bulkPanel = $state(false);
	const panelOpen = $derived(data.bulk || bulkPanel);
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

{#snippet rowItem(row: RowRecord)}
	<tr class:selected={selected.has(row.id)}>
		{#if data.canEdit}
			<td class="pick">{@render rowPick(row)}</td>
		{/if}
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
{/snippet}

{#snippet cardItem(row: RowRecord)}
	<li class="card" class:selected={selected.has(row.id)}>
		<div class="card-head">
			{#if data.canEdit}<span class="card-pick">{@render rowPick(row)}</span>{/if}
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
{/snippet}

{#snippet groupHead(section: GroupSection)}
	<a
		class="group-toggle"
		href={hrefWith({ collapsed: toggleCollapsedKey(data.collapsed as string[], section.key) })}
		aria-expanded={!section.collapsed}
		title={section.collapsed ? 'Expand group' : 'Collapse group'}>{section.collapsed ? '▸' : '▾'}</a
	>
{/snippet}


{#snippet fieldInput(prop: Property, row: RowRecord | null)}
	{#if prop.type === 'checkbox'}
		<input type="hidden" name={`p:${prop.name}`} value="0" />
		<input type="checkbox" name={`p:${prop.name}`} value="1" checked={row?.values[prop.name] === true} />
	{:else if prop.type === 'select'}
		<select name={`p:${prop.name}`}>
			<option value="">—</option>
			{#each prop.options ?? [] as option (option)}
				<option value={option} selected={fieldValue(prop, row) === option}>{option}</option>
			{/each}
		</select>
	{:else if prop.type === 'multi_select'}
		<span class="multi">
			{#each prop.options ?? [] as option (option)}
				<label class="check">
					<input type="checkbox" name={`p:${prop.name}`} value={option} checked={listValue(prop, row).includes(option)} />
					{option}
				</label>
			{/each}
		</span>
	{:else if prop.type === 'number'}
		<input type="number" step="any" name={`p:${prop.name}`} value={fieldValue(prop, row)} />
	{:else if prop.type === 'date'}
		<input type="date" name={`p:${prop.name}`} value={fieldValue(prop, row)} />
	{:else if prop.type === 'url'}
		<input type="url" name={`p:${prop.name}`} value={fieldValue(prop, row)} />
	{:else if prop.type === 'email'}
		<input type="email" name={`p:${prop.name}`} value={fieldValue(prop, row)} />
	{:else}
		<input type="text" name={`p:${prop.name}`} value={fieldValue(prop, row)} />
	{/if}
{/snippet}

{#snippet rowPick(row: RowRecord)}
	<input type="checkbox" name="row_id" value={row.id} form="bulk-form" aria-label={`Select ${bulkLabel(row)}`} checked={selected.has(row.id)} onchange={(e) => toggleRow(row.id, e.currentTarget.checked)} />
	<input type="hidden" name={`base:${row.id}`} value={row.updated_at} form="bulk-form" />
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
			{#if data.canEdit}<a class="btn small" href={hrefWith({ bulk: '1', saved: null })}>Bulk edit</a>{/if}
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
		<div class="saved-row">
			<p class="notice ok" role="status">Saved.</p>
			{#if data.canEdit && data.batch}
				<form class="saved-undo" method="post" action="?/undo">
					<input type="hidden" name="batch_id" value={data.batch} />
					<button class="btn small" type="submit">Undo bulk change</button>
				</form>
			{/if}
		</div>
	{/if}
	{#if form?.error}
		<p class="notice bad" role="alert">{form.error}</p>
	{/if}

	{#if data.canEdit}
		<!-- One form for the whole selection: the row checkboxes join it through form="bulk-form", so
		     the panel can sit above the table and the table keeps its own markup. -->
		<form id="bulk-form" method="post" action="?/bulk">
			{#if selectedCount || panelOpen}
				<div class="bulk">
					<div class="bulk-bar">
						<span class="bulk-count">{selectedCount ? `${selectedCount} selected` : 'Bulk edit'}</span>
						{#if !panelOpen}
							<a
								class="btn small primary"
								href={hrefWith({ bulk: '1', saved: null })}
								onclick={(e) => {
									e.preventDefault();
									bulkPanel = true;
								}}>Bulk edit</a
							>
						{/if}
						<button class="btn small" type="button" onclick={() => (selected = new Set())}>Clear</button>
					</div>
					{#if panelOpen}
						<div class="bulk-fields">
							<label class="field">
								<span>Property</span>
								<select name="property" bind:value={bulkProp}>
									<option value="">Choose…</option>
									{#each bulkProperties as prop (prop.id)}
										<option value={prop.name}>{prop.name}</option>
									{/each}
								</select>
							</label>
							{#each bulkProperties as prop (prop.id)}
								{#if !bulkProp || bulkProp === prop.name}
									<label class="field">
										<span>New value for {prop.name}</span>
										{@render fieldInput(prop, null)}
									</label>
								{/if}
							{/each}
						</div>
						<div class="bulk-actions">
							<button class="btn small primary" type="submit">Apply to {selectedCount ? `${selectedCount} ` : 'selected '}rows</button>
							<a
								class="btn small"
								href={hrefWith({ bulk: null, saved: null })}
								onclick={(e) => {
									e.preventDefault();
									bulkPanel = false;
								}}>Close</a
							>
						</div>
					{/if}
				</div>
			{/if}
		</form>
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
							{@render fieldInput(prop, data.editing)}
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
		{#if data.groupParam !== null}<input type="hidden" name="group" value={data.groupParam ?? ''} />{/if}
		{#if (data.collapsed as string[]).length}<input type="hidden" name="collapsed" value={collapsedParam(data.collapsed as string[])} />{/if}
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

	{#if data.canEdit}
		<form class="save-view" method="post" action="?/saveView">
			{#if data.view}<input type="hidden" name="view" value={data.view} />{/if}
			{#each data.filters as filter, i (i)}
				<input type="hidden" name="p{i}" value={filter.property} />
				<input type="hidden" name="o{i}" value={filter.op} />
				<input type="hidden" name="v{i}" value={String(filter.value ?? '')} />
			{/each}
			{#if currentSort}<input type="hidden" name="sort" value={currentSort} />{/if}
			{#if data.group}<input type="hidden" name="group" value={data.group} />{/if}
			<label for="view-name">Save current filters, sorts and grouping as a view</label>
			<input id="view-name" name="view_name" placeholder="View name" required maxlength="80" />
			<button class="btn small" type="submit">Save view</button>
		</form>
	{/if}

	<div class="table-wrap">
		<table>
			<thead>
				<tr>
					{#if data.canEdit}
						<th scope="col" class="pick">
							<input
								type="checkbox"
								aria-label="Select all rows on this page"
								checked={allSelected}
								onchange={(e) => toggleAllRows(e.currentTarget.checked)}
							/>
						</th>
					{/if}
					{#each visible as prop (prop.id)}
						<th scope="col">
							<a href={sortHref(prop.name)} title="Sort by {prop.name}">{prop.name} <span class="sort-mark">{sortMark(prop.name)}</span></a>
						</th>
					{/each}
				</tr>
			</thead>
			{#if sections}
				{#each sections as section (section.key ?? EMPTY_GROUP_KEY)}
					<tbody class="group-body">
						<tr class="group-head">
							<th scope="colgroup" colspan={visible.length + (data.canEdit ? 1 : 0)}>
								{@render groupHead(section)}
								<span class="group-label">{groupLabel(section)}</span>
								<span class="group-count">{section.count}</span>
							</th>
						</tr>
						{#each section.rows as row (row.id)}
							{@render rowItem(row)}
						{/each}
					</tbody>
				{/each}
				{#if sections.length === 0}
					<tbody><tr><td class="empty" colspan={visible.length + (data.canEdit ? 1 : 0)}>No rows match.</td></tr></tbody>
				{/if}
			{:else}
				<tbody>
					{#each data.rows as row (row.id)}
						{@render rowItem(row)}
					{:else}
						<tr><td class="empty" colspan={visible.length + (data.canEdit ? 1 : 0)}>No rows match.</td></tr>
					{/each}
				</tbody>
			{/if}
			{#if data.aggregates}
				<tfoot>
					<tr>
						{#if data.canEdit}<td class="pick"></td>{/if}
						{#each visible as prop (prop.id)}
							{#if prop.id === titleProp?.id}
								<th scope="row" class="cell type-{prop.type}">{aggregateText(prop)}</th>
							{:else}
								<td class="cell type-{prop.type}">{aggregateText(prop)}</td>
							{/if}
						{/each}
					</tr>
				</tfoot>
			{/if}
		</table>
	</div>

	<form class="card-sort" method="get" aria-label="Sort rows">
		{#if data.view}<input type="hidden" name="view" value={data.view} />{/if}
		{#each data.filters as filter, i (i)}
			<input type="hidden" name="p{i}" value={filter.property} />
			<input type="hidden" name="o{i}" value={filter.op} />
			<input type="hidden" name="v{i}" value={String(filter.value ?? '')} />
		{/each}
		{#if data.groupParam !== null}<input type="hidden" name="group" value={data.groupParam ?? ''} />{/if}
		{#if (data.collapsed as string[]).length}<input type="hidden" name="collapsed" value={collapsedParam(data.collapsed as string[])} />{/if}
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
		{#if sections}
			{#each sections as section (section.key ?? EMPTY_GROUP_KEY)}
				<li class="card-group-head">
					<a href={hrefWith({ collapsed: toggleCollapsedKey(data.collapsed as string[], section.key) })}>
						<span>{groupLabel(section)}</span>
						<span class="group-count">{section.count}</span>
					</a>
				</li>
				{#each section.rows as row (row.id)}
					{@render cardItem(row)}
				{/each}
			{/each}
			{#if sections.length === 0}
				<li class="card empty">No rows match.</li>
			{/if}
		{:else}
			{#each data.rows as row (row.id)}
				{@render cardItem(row)}
			{:else}
				<li class="card empty">No rows match.</li>
			{/each}
		{/if}
	</ul>

	{#if data.canEdit && data.batches.length}
		<section class="batches" aria-label="Recent bulk changes">
			<h2>Recent bulk changes</h2>
			<ul>
				{#each data.batches as batch (batch.batch_id)}
					<li>
						<form method="post" action="?/undo">
							<input type="hidden" name="batch_id" value={batch.batch_id} />
							<time datetime={batch.at}>{batch.at.slice(0, 16).replace('T', ' ')} UTC</time>
							<span class="muted">{batch.actor}</span>
							<span>{batch.row_count} {batch.row_count === 1 ? 'row' : 'rows'}</span>
							{#if batch.undone}
								<span class="chip">undone</span>
							{:else}
								<button class="btn small" type="submit">Undo</button>
							{/if}
						</form>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

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
	.save-view { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; margin: 0 0 1rem; }
	.save-view label { color: var(--muted); font: 700 0.7rem var(--mono); letter-spacing: 0.05em; text-transform: uppercase; }
	.save-view input { min-height: 30px; padding: 0.25rem 0.5rem; color: var(--fg); background: var(--panel); border: 1px solid var(--border); border-radius: 6px; font: inherit; }
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

	/* Bulk edit: the panel the selection bar opens, plus the tick column in table and cards. */
	.bulk { border: 1px solid var(--border); border-radius: 8px; background: var(--panel); padding: 0.7rem 0.9rem; margin: 0 0 1rem; display: grid; gap: 0.7rem; }
	.bulk-bar { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
	.bulk-count { font: 700 0.74rem var(--mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
	.bulk-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 0.6rem 0.8rem; }
	.bulk-actions { display: flex; gap: 0.4rem; flex-wrap: wrap; }
	.pick { width: 2.4rem; text-align: center; }
	.pick input[type='checkbox'], .card-pick input[type='checkbox'] { width: 16px; height: 16px; accent-color: var(--accent); vertical-align: middle; }
	.card-pick { display: inline-flex; align-items: center; margin-right: 0.25rem; }
	tr.selected :is(td, th), .card.selected { background: color-mix(in srgb, var(--accent) 9%, transparent); }
	.batches { margin: 1rem 0 0; border-top: 1px solid var(--border); padding-top: 0.7rem; }
	.batches h2 { margin: 0 0 0.5rem; font: 700 0.72rem var(--mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
	.batches ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.4rem; }
	.batches form { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; font-size: 0.85rem; }
	.batches time { font: 0.78rem var(--mono); color: var(--muted); }
	.saved-row { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
	.title-cell { display: inline-flex; align-items: baseline; gap: 0.6rem; }
	.edit-link { font-size: 0.72rem; color: var(--muted); opacity: 0; }
	tr:hover .edit-link, .edit-link:focus-visible { opacity: 1; }
	@media (hover: none) { .edit-link { opacity: 1; } }

	/* Grouped table: a header row opens each group's tbody, a footer row carries the aggregates. */
	.group-body { border-top: 1px solid var(--border); }
	.group-head th { background: color-mix(in srgb, var(--fg) 3%, transparent); font-weight: 400; padding: 0.3rem 0.7rem; }
	.group-toggle { color: var(--muted); text-decoration: none; margin-right: 0.45rem; font: 700 0.8rem var(--mono); }
	.group-toggle:hover { color: var(--fg); text-decoration: none; }
	.group-label { font-weight: 700; overflow-wrap: anywhere; white-space: normal; }
	.group-count { display: inline-block; margin-left: 0.45rem; padding: 0 6px; border: 1px solid var(--border); border-radius: 999px; font: 700 0.68rem var(--mono); color: var(--muted); }
	tfoot th, tfoot td { position: static; background: var(--panel); border-top: 2px solid var(--border); border-bottom: none; font: 700 0.78rem var(--mono); color: var(--fg); text-transform: none; letter-spacing: normal; white-space: normal; }

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
		.card-group-head { list-style: none; margin: 0.4rem 0 0; }
		.card-group-head a { display: flex; align-items: center; gap: 0.4rem; padding: 0.2rem 0.1rem; color: var(--muted); font: 700 0.72rem var(--mono); letter-spacing: 0.05em; text-transform: uppercase; }
		.card-group-head a:hover { color: var(--fg); text-decoration: none; }
		.card-group-head .group-count { margin-left: 0; }
	}
</style>
