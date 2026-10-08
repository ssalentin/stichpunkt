<script lang="ts">
	import { BRAND } from '#lib/brand';
	import { goto } from '$app/navigation';

	let { data } = $props();
	let q = $state(data.q);
	$effect(() => void (q = data.q));

	/** splits a snippet into plain/matching segments so no HTML is ever injected */
	function segments(text: string, query: string): { t: string; m: boolean }[] {
		const terms = query.toLowerCase().split(/\s+/).filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
		if (!terms.length) return [{ t: text, m: false }];
		return text
			.split(new RegExp(`(${terms.join('|')})`, 'i'))
			.filter(Boolean)
			.map((t) => ({ t, m: terms.some((x) => new RegExp(`^${x}$`, 'i').test(t)) }));
	}
</script>

<svelte:head><title>Search · {BRAND}</title></svelte:head>
<article class="page">
	<form onsubmit={(e) => (e.preventDefault(), goto(`/search?q=${encodeURIComponent(q)}`, { keepFocus: true }))}>
		<input class="searchbox" type="search" bind:value={q} placeholder="Search all pages" enterkeyhint="search" autocapitalize="off" />
	</form>
	{#if data.q}<p class="muted">{data.results.length} result{data.results.length === 1 ? '' : 's'}</p>{/if}
	<ul class="results">
		{#each data.results as r (r.path)}
			<li>
				<a href="/{encodeURI(r.path)}">{r.path}</a>
				<p>{#each segments(r.snippet, data.q) as s}{#if s.m}<mark>{s.t}</mark>{:else}{s.t}{/if}{/each}</p>
			</li>
		{/each}
	</ul>
</article>
