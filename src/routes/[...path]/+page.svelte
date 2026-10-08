<script lang="ts">
	import { BRAND } from '#lib/brand';
	import { afterNavigate } from '$app/navigation';
	import { enhance } from '#lib/client/diagrams';

	let { data } = $props();
	let article: HTMLElement | undefined = $state();

	$effect(() => {
		data.view?.html;
		if (article) enhance(article);
	});
	afterNavigate(({ to }) => {
		const hash = to?.url.hash;
		if (hash) document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView();
	});

	const props = $derived(Object.entries(data.view?.frontmatter ?? {}));
	const fmt = (v: unknown) => (typeof v === 'object' ? JSON.stringify(v) : String(v));
</script>

<svelte:head><title>{data.name} · {BRAND}</title></svelte:head>

{#if data.kind === 'page' && data.view}
	<article class="page" bind:this={article}>
		{#if props.length}
			<details class="props">
				<summary>Properties</summary>
				<dl>{#each props as [k, v]}<dt>{k}</dt><dd>{fmt(v)}</dd>{/each}</dl>
			</details>
		{/if}
		<div class="md">{@html data.view.html}</div>
		{#each data.view.tagLists as list (list.tag)}
			<section class="tagged">
				<h2>Pages tagged <a class="tag" href="/tag/{encodeURI(list.tag)}">#{list.tag}</a></h2>
				{#if list.pages.length}
					<ul>{#each list.pages as p}<li><a href="/{encodeURI(p.path)}">{p.path}</a></li>{/each}</ul>
				{:else}<p class="muted">No other pages.</p>{/if}
			</section>
		{/each}
	</article>
{:else}
	<article class="page">
		<h1>{data.name}</h1>
		<p class="muted">This page does not exist. Pages are written by agents through the MCP server.</p>
		{#if data.namespace.length}
			<h2>In {data.name}/</h2>
			<ul>{#each data.namespace as p}<li><a href="/{encodeURI(p.path)}">{p.path}</a></li>{/each}</ul>
		{/if}
	</article>
{/if}
