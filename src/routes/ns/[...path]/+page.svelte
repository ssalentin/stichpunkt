<script lang="ts">
	import { BRAND } from '#lib/brand';
	import { layerInView } from '#lib/layers';
	import { ui } from '#lib/ui.svelte';
	let { data } = $props();
	const pages = $derived(data.pages.filter((entry: { layer?: string }) => layerInView(entry.layer ?? 'reading', ui.layerView)));
</script>

<svelte:head><title>{data.prefix}/ · {BRAND}</title></svelte:head>
<article class="page">
	<h1>{data.prefix}/</h1>
	{#if data.exists}<p><a href="/{encodeURI(data.prefix)}">Open page {data.prefix}</a></p>{/if}
	{#if pages.length}
		<ul class="list">{#each pages as p}<li><a href="/{encodeURI(p.path)}" title={p.path}>{p.title ?? p.path}</a></li>{/each}</ul>
	{:else}<p class="muted">No pages in this namespace.</p>{/if}
</article>
