<script lang="ts">
	import { BRAND } from '#lib/brand';
	let { data } = $props();
</script>

<svelte:head><title>#{data.tag} · {BRAND}</title></svelte:head>
<article class="page">
	<h1>Pages tagged <span class="tag">#{data.tag}</span></h1>
	{#if data.tagPage}<p class="muted">Collection page: <a href="/{encodeURI(data.tagPage)}">{data.tagPage}</a></p>{/if}
	{#if data.pages.length}
		<ul class="list">{#each data.pages as p}<li><a href="/{encodeURI(p.path)}" title={p.path}>{p.title ?? p.path}</a></li>{/each}</ul>
	{:else}<p class="muted">No pages carry this tag.</p>{/if}
</article>
