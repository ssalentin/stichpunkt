<script lang="ts">
	import { BRAND } from '#lib/brand';
	import Icon from '#lib/components/Icon.svelte';
	import { goto } from '$app/navigation';
	import { rank, type Titled } from '#lib/fuzzy';
	import { onMount } from 'svelte';

	let { data } = $props();
	// svelte-ignore state_referenced_locally -- q seeds from data.q once, then the effect below resyncs it on navigation
	let q = $state(data.q);
	$effect(() => void (q = data.q));

	let input = $state<HTMLInputElement>();
	let searches = $state<string[]>([]);

	const result = $derived(data.result);
	const terms = $derived(result?.terms ?? []);
	/** title suggestions while typing: a lexical miss should still lead somewhere */
	const jumps = $derived(q.trim() ? rank(data.jumpTitles, q, [], 4) : []);
	/** tags the query points at ("#fin") or tags that occur in the corpus */
	const tagHits = $derived.by(() => {
		const needle = q.trim().replace(/^#/, '').toLowerCase();
		if (!q.trim()) return data.tagNames.slice(0, 12);
		return data.tagNames.filter((t) => t.toLowerCase().includes(needle) && needle.length > 1).slice(0, 8);
	});

	onMount(() => {
		try {
			const raw = JSON.parse(localStorage.getItem('stichpunkt.searches') ?? '[]');
			if (Array.isArray(raw)) searches = raw.filter((s): s is string => typeof s === 'string').slice(0, 8);
		} catch {
			/* private mode: no history */
		}
		input?.focus();
	});

	function rememberSearch(value: string) {
		const v = value.trim();
		if (!v) return;
		searches = [v, ...searches.filter((s) => s !== v)].slice(0, 8);
		try {
			localStorage.setItem('stichpunkt.searches', JSON.stringify(searches));
		} catch {
			/* private mode */
		}
	}

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
		rememberSearch(q);
		goto(`/search?q=${encodeURIComponent(q)}`, { reset: false });
	}

	function jumpTo(item: Titled) {
		rememberSearch(q);
		goto(`/${encodeURI(item.path)}`);
	}

	function run(value: string) {
		q = value;
		submit();
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

	function clear() {
		q = '';
		goto('/search');
	}
</script>

<svelte:head><title>Search · {BRAND}</title></svelte:head>

<div class="searchwrap">
	<form class="searchbar" onsubmit={(e) => (e.preventDefault(), submit())}>
		<span class="mag"><Icon name="search" size={18} /></span>
		<input
			class="searchbox"
			type="search"
			bind:this={input}
			bind:value={q}
			placeholder="Search pages, #tags, in:folder"
			enterkeyhint="search"
			autocapitalize="off"
			autocomplete="off"
			spellcheck="false"
			aria-label="Search all pages"
		/>
		{#if q}<button type="button" class="search-clear" aria-label="Clear search" onclick={clear}><span aria-hidden="true">×</span></button>{/if}
	</form>

	{#if result}
		{#if result.filters.tags.length || result.filters.folders.length}
			<div class="activefilters">
				{#each result.filters.tags as t}<button class="chipchip" onclick={() => removeToken(`#${t}`)}>#{t} <span aria-hidden="true">×</span></button>{/each}
				{#each result.filters.folders as f}<button class="chipchip" onclick={() => removeToken(`in:${f}`)}>in:{f} <span aria-hidden="true">×</span></button>{/each}
			</div>
		{/if}

		{#if jumps.length}
			<div class="search-suggest">
				<span class="suggest-key">Jump to</span>
				{#each jumps as j (j.path)}
					<button class="suggest" onclick={() => jumpTo(j)} title={j.path}>{j.title}</button>
				{/each}
			</div>
		{/if}

		<p class="count" aria-live="polite">
			{result.total} {result.total === 1 ? 'page' : 'pages'}
			{#if result.mode === 'or'}<span class="count-note">· some words do not occur, showing partial matches</span>{/if}
			{#if result.mode === 'fuzzy'}<span class="count-note">· no exact match, nearest pages</span>{/if}
		</p>

		{#if result.results.length}
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
				{/each}
			</ul>
		{:else}
			<div class="empty">
				<p>No page matches <strong>{data.q}</strong>.</p>
				<p class="muted">Check the spelling, drop a filter, or search for a single word.</p>
			</div>
		{/if}
	{:else}
		{#if searches.length}
			<section class="search-history">
				<h2>Recent searches</h2>
				<div class="chiprow">
					{#each searches as s (s)}<button class="facet" onclick={() => run(s)}>{s}</button>{/each}
				</div>
			</section>
		{/if}

		{@render tagChips('Tags')}

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

{#snippet tagChips(label: string)}
	{#if tagHits.length}
		<section class="search-tags">
			<h2>{label}</h2>
			<div class="chiprow">{#each tagHits as t (t)}<button class="facet" onclick={() => run(`#${t}`)}>#{t}</button>{/each}</div>
		</section>
	{/if}
{/snippet}
