<script lang="ts">
	import { BRAND } from '#lib/brand';
	import { afterNavigate, invalidateAll } from '$app/navigation';
	import { enhance } from '#lib/client/diagrams';
	import { api, toast } from '#lib/ui.svelte';

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

	async function onchange(e: Event) {
		const box = e.target as HTMLInputElement;
		if (!box.matches?.('input.task') || !data.view) return;
		const checked = box.checked;
		const r = await api('POST', '/_ui/toggle', {
			path: data.view.path,
			line: Number(box.dataset.line),
			base_hash: data.view.hash
		});
		if (r.status !== 200) {
			box.checked = !checked;
			toast(r.status === 409 ? 'Page changed meanwhile, reloaded' : (r.data?.message ?? 'Could not save'));
		}
		// reload page data so the hash matches the file again
		await invalidateAll();
	}

	const props = $derived(Object.entries(data.view?.frontmatter ?? {}));
	const fmt = (v: unknown) => (typeof v === 'object' ? JSON.stringify(v) : String(v));
</script>

<svelte:head><title>{data.name} · {BRAND}</title></svelte:head>

{#if data.edit}
	{#await import('#lib/components/Editor.svelte')}
		<p class="muted pad">Loading editor…</p>
	{:then { default: Editor }}
		{#key data.name}
			<Editor
				path={data.name}
				initial={data.raw?.content ?? ''}
				baseHash={data.raw ? data.raw.hash : ''}
			/>
		{/key}
	{/await}
{:else if data.kind === 'page' && data.view}
	<article class="page" bind:this={article} onchange={onchange}>
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
		<p class="muted">This page does not exist yet.</p>
		<p><a class="btn primary" href="/{encodeURI(data.name)}?edit=1">Create page</a></p>
		{#if data.namespace.length}
			<h2>In {data.name}/</h2>
			<ul>{#each data.namespace as p}<li><a href="/{encodeURI(p.path)}">{p.path}</a></li>{/each}</ul>
		{/if}
	</article>
{/if}
