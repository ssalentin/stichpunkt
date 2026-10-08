<script lang="ts">
	import { BRAND, BRAND_TAGLINE, BRAND_DESCRIPTION } from '#lib/brand';
	import Logo from '#lib/components/Logo.svelte';
	import { ui } from '#lib/ui.svelte';

	let { data } = $props();
</script>

<svelte:head>
	<title>{BRAND} · {BRAND_TAGLINE}</title>
	<meta name="description" content={BRAND_DESCRIPTION} />
</svelte:head>

<div class="home">
	<header class="home-head">
		<Logo size={56} />
		<div class="home-title">
			<h1>{BRAND}<span class="dot">.</span></h1>
			<p class="tagline">{BRAND_TAGLINE}</p>
		</div>
	</header>
	<p class="home-lead">{BRAND_DESCRIPTION}</p>

	<div class="home-actions">
		<a class="btn primary" href="/index">Open the wiki</a>
		<button class="btn" onclick={() => (ui.switcher = 'switch')}>Search <kbd>⌘K</kbd></button>
	</div>

	<section class="home-panel">
		<h2>Recently changed</h2>
		{#if data.recent.length}
			<ul class="home-list">
				{#each data.recent as r (r.path)}
					<li>
						<a href="/{encodeURI(r.path)}">{r.title}</a>
						{#if r.path.includes('/')}<span class="muted">{r.path.slice(0, r.path.lastIndexOf('/'))}/</span>{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="muted">No pages yet.</p>
		{/if}
	</section>

	{#if data.tags.length}
		<section class="home-panel">
			<h2>Tags</h2>
			<p class="taglist">
				{#each data.tags as t (t.name)}<a class="tag" href="/tag/{encodeURI(t.name)}">#{t.name}</a>{/each}
			</p>
		</section>
	{/if}

	<p class="home-foot muted">{data.pageCount} {data.pageCount === 1 ? 'page' : 'pages'} · written by agents through MCP</p>
</div>
