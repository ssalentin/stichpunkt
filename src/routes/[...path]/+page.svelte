<script lang="ts">
	import { BRAND, BRAND_TAGLINE } from '#lib/brand';
	import Logo from '#lib/components/Logo.svelte';
	import { afterNavigate } from '$app/navigation';
	import { enhance, preload } from '#lib/client/diagrams';
	import { markChanges } from '#lib/client/live';
	import { toast } from '#lib/ui.svelte';
	import { tick } from 'svelte';

	let { data } = $props();
	let article: HTMLElement | undefined = $state();

	// the knowledge base's start page wears the brand mark, like the landing page
	const isHome = $derived(data.kind === 'page' && data.name === 'index');

	// what this component showed last, to flash what a live reload changed (never reactive)
	let shown: { name: string; html: string | null } | null = null;
	let clearTimer: ReturnType<typeof setTimeout>;

	$effect(() => {
		const name = data.name;
		const html = data.view?.html ?? null;
		if (article) enhance(article);
		const prev = shown;
		shown = { name, html };
		// only a reload of the page that is already open counts as a live change, not a navigation
		if (!prev || prev.name !== name || prev.html === html) return;
		void tick().then(() => announce(prev.html, html));
	});

	function announce(oldHtml: string | null, newHtml: string | null) {
		if (oldHtml === null) return toast('This page was just created');
		if (newHtml === null) return toast('This page was deleted');
		const root = article?.querySelector<HTMLElement>('.md');
		const first = root ? markChanges(root, oldHtml, newHtml, 'live-changed') : null;
		clearTimeout(clearTimer);
		clearTimer = setTimeout(() => root?.querySelectorAll('.live-changed').forEach((el) => el.classList.remove('live-changed')), 3500);
		const offscreen = first && (first.getBoundingClientRect().bottom < 0 || first.getBoundingClientRect().top > innerHeight);
		toast('Page updated', offscreen ? { label: 'Show change', run: () => first.scrollIntoView({ block: 'center', behavior: 'smooth' }) } : null);
	}
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
		{#if isHome}
			<div class="page-brand">
				<Logo size={40} />
				<span class="page-brand-name">{BRAND}<span class="dot">.</span></span>
				<span class="page-brand-tag">{BRAND_TAGLINE}</span>
			</div>
		{/if}
		{#if data.view.layer === 'working'}
			<p class="layer-badge" role="note" aria-label="{data.layers.working} draft, not curated">{data.layers.working} draft, not curated</p>
		{/if}
		<div class="md">{@html data.view.html}</div>
		{#each data.view.tagLists as list (list.tag)}
			<section class="tagged">
				<h2>Pages tagged <a class="tag" href="/tag/{encodeURI(list.tag)}">#{list.tag}</a></h2>
				{#if list.pages.length}
					<ul>{#each list.pages as p}<li><a href="/{encodeURI(p.path)}" title={p.path}>{p.title ?? p.path}</a></li>{/each}</ul>
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
			<ul>{#each data.namespace as p}<li><a href="/{encodeURI(p.path)}" title={p.path}>{p.title ?? p.path}</a></li>{/each}</ul>
		{/if}
	</article>
{/if}
