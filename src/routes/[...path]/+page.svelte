<script lang="ts">
	import { BRAND } from '#lib/brand';
	import { afterNavigate } from '$app/navigation';
	import { enhance, preload } from '#lib/client/diagrams';

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

	// start fetching the diagram libraries as soon as the page data is known, so the
	// rendered figure replaces the placeholder without ever showing the source first
	$effect.pre(() => preload(data.view?.usedClient ?? []));
</script>

<svelte:head><title>{data.name} · {BRAND}</title></svelte:head>

{#if data.kind === 'page' && data.view}
	<article class="page" bind:this={article}>
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
