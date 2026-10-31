<script lang="ts">
	import { BRAND } from '#lib/brand';
	let { data } = $props();
</script>

<svelte:head><title>Databases · {BRAND}</title></svelte:head>

<article class="page databases">
	<header class="db-head">
		<p class="eyebrow">System</p>
		<h1>Databases</h1>
	</header>
	<p class="muted intro">Structured collections stored in SQLite next to the space. Rows, typed properties and saved views; every change is versioned.</p>

	{#if data.databases.length}
		<ul class="db-list">
			{#each data.databases as db (db.id)}
				<li>
					<a class="db-card" href="/databases/{db.id}">
						<span class="db-icon" aria-hidden="true">{db.icon ?? '▦'}</span>
						<span class="db-body">
							<span class="db-name">{db.name}</span>
							<span class="db-meta">{db.row_count} {db.row_count === 1 ? 'row' : 'rows'} · {db.properties.length} properties · {db.view_count} {db.view_count === 1 ? 'view' : 'views'}</span>
						</span>
					</a>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="notice">No databases yet. Agents create them through <code>POST /api/v1/databases</code>.</p>
	{/if}
</article>

<style>
	.databases { max-width: 78ch; }
	.eyebrow { margin: 0; font: 700 0.72rem var(--mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }
	.db-head h1 { margin: 0.15rem 0 0.6rem; }
	.intro { margin: 0 0 1.4rem; }
	.db-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.6rem; }
	.db-card { display: flex; gap: 0.8rem; align-items: center; padding: 0.75rem 0.9rem; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); color: var(--fg); }
	.db-card:hover { border-color: var(--accent); text-decoration: none; }
	.db-icon { font-size: 1.25rem; width: 2rem; text-align: center; }
	.db-body { display: flex; flex-direction: column; min-width: 0; }
	.db-name { font-weight: 700; }
	.db-meta { color: var(--muted); font-size: 0.8rem; }
	.notice { padding: 0.6rem 0.8rem; border-left: 3px solid var(--accent); background: var(--panel); }
</style>
