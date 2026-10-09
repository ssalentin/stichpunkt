<script lang="ts">
	import { BRAND } from '#lib/brand';
	import { goto } from '$app/navigation';

	let { data } = $props();
	let q = $state(data.q);
	$effect(() => void (q = data.q));

	const result = $derived(data.result);
	const terms = $derived(result?.terms ?? []);

	function esc(s: string) {
		return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	/** splits text into plain/matching segments so no HTML is ever injected */
	function segments(text: string, list: string[]): { t: string; m: boolean }[] {
		const parts = list.filter((t) => t.length > 1).map(esc);
		if (!parts.length) return [{ t: text, m: false }];
		return text
			.split(new RegExp(`(${parts.join('|')})`, 'gi'))
			.filter(Boolean)
			.map((t) => ({ t, m: parts.some((x) => new RegExp(`^${x}$`, 'i').test(t)) }));
	}

	function folderOf(p: string) {
		return p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
	}

	function submit() {
		goto(`/search?q=${encodeURIComponent(q)}`, { reset: false });
	}

	/** refine the current query with a facet without losing the rest */
	function refine(kind: 'tag' | 'folder', value: string) {
		const token = kind === 'tag' ? `#${value}` : `in:${value}`;
		const next = data.q.includes(token) ? data.q : `${token} ${data.q}`.trim();
		goto(`/search?q=${encodeURIComponent(next)}`);
	}

	function removeToken(token: string) {
		goto(`/search?q=${encodeURIComponent(data.q.split(/\s+/).filter((w) => w !== token).join(' '))}`);
	}
</script>

<svelte:head><title>Search · {BRAND}</title></svelte:head>

<div class="searchwrap">
	<form class="searchbar" onsubmit={(e) => (e.preventDefault(), submit())}>
		<span class="mag" aria-hidden="true">⌕</span>
		<input
			class="searchbox"
			type="search"
			bind:value={q}
			placeholder="Search pages, #tags, in:folder"
			enterkeyhint="search"
			autocapitalize="off"
			autocomplete="off"
			spellcheck="false"
			aria-label="Search all pages"
		/>
	</form>

	{#if result}
		<div class="activefilters">
			{#each result.filters.tags as t}<button class="chipchip" onclick={() => removeToken(`#${t}`)}>#{t} <span aria-hidden="true">×</span></button>{/each}
			{#each result.filters.folders as f}<button class="chipchip" onclick={() => removeToken(`in:${f}`)}>in:{f} <span aria-hidden="true">×</span></button>{/each}
		</div>

		{#if result.results.length}
			<p class="count">{result.total} {result.total === 1 ? 'page' : 'pages'}</p>

			{#if result.facets.folders.length > 1 || result.facets.tags.length}
				<div class="facets">
					{#if result.facets.folders.length > 1}
						<div class="facet-row">
							<span class="facet-key">Folders</span>
							{#each result.facets.folders as f}
								<button class="facet" onclick={() => refine('folder', f.name)}>{f.name}<span class="n">{f.count}</span></button>
							{/each}
						</div>
					{/if}
					{#if result.facets.tags.length}
						<div class="facet-row">
							<span class="facet-key">Tags</span>
							{#each result.facets.tags as t}
								<button class="facet" onclick={() => refine('tag', t.name)}>#{t.name}<span class="n">{t.count}</span></button>
							{/each}
						</div>
					{/if}
				</div>
			{/if}

			<ul class="hits">
				{#each result.results as r (r.path)}
					<li class="hit">
						<a class="hit-title" href="/{encodeURI(r.path)}">
							<span class="hit-name">{r.title}</span>
							{#if folderOf(r.path)}<span class="hit-folder">{folderOf(r.path)}/</span>{/if}
						</a>
						{#if r.section.heading}
							<a class="hit-section" href="/{encodeURI(r.path)}#{encodeURI(r.section.slug)}">
								<span aria-hidden="true">↳</span> {r.section.heading}
							</a>
						{/if}
						{#if r.snippet}
							<p class="hit-snippet">{#each segments(r.snippet, terms) as s}{#if s.m}<mark>{s.t}</mark>{:else}{s.t}{/if}{/each}</p>
						{/if}
						{#if r.tags.length}
							<div class="hit-tags">{#each r.tags as t}<a class="tag" href="/tag/{encodeURI(t)}">#{t}</a>{/each}</div>
						{/if}
					</li>
				{:else}
					<li class="muted">No page matches “{data.q}”. Try fewer words or a different tag.</li>
				{/each}
			</ul>
		{:else}
			<div class="empty">
				<p>No page matches <strong>{data.q}</strong>.</p>
				<p class="muted">Check the spelling, drop a filter, or search for a single word.</p>
			</div>
		{/if}
	{:else}
		<section class="recent-block">
			<h2>Recently changed</h2>
			<ul class="hits">
				{#each data.recent as r (r.path)}
					<li class="hit">
						<a class="hit-title" href="/{encodeURI(r.path)}"><span class="hit-name">{r.title}</span>{#if folderOf(r.path)}<span class="hit-folder">{folderOf(r.path)}/</span>{/if}</a>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</div>
