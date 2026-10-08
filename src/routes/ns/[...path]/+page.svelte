<script lang="ts">
	let { data } = $props();
</script>

<svelte:head><title>{data.prefix}/ · folio</title></svelte:head>
<article class="page">
	<h1>{data.prefix}/</h1>
	{#if data.exists}<p><a href="/{encodeURI(data.prefix)}">Open page {data.prefix}</a></p>{/if}
	{#if data.pages.length}
		<ul class="list">{#each data.pages as p}<li><a href="/{encodeURI(p.path)}">{p.path}</a></li>{/each}</ul>
	{:else}<p class="muted">No pages in this namespace.</p>{/if}
</article>
