<script lang="ts">
	import '../app.css';
	import { BRAND, BRAND_REPO, BRAND_TAGLINE } from '#lib/brand';
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import Icon from '#lib/components/Icon.svelte';
	import ThemeSwitch from '#lib/components/ThemeSwitch.svelte';
	import Panel from '#lib/components/Panel.svelte';
	import Switcher from '#lib/components/Switcher.svelte';
	import Tree from '#lib/components/Tree.svelte';
	import { APP_VERSION, APP_COMMIT, shortCommit } from '#lib/version';
	import { ui, visit } from '#lib/ui.svelte';
	import { install, listenForInstall, pwa } from '#lib/client/pwa.svelte';
	import { onMount } from 'svelte';

	let { data, children } = $props();

	const current = $derived(page.data.name ?? '');
	const view = $derived(page.data.kind === 'page' ? page.data.view : null);
	let treeOpen = $state(true);
	let panelOpen = $state(true);

	// breadcrumbs: every folder links to its namespace listing
	const crumbs = $derived.by(() => {
		const p: string = page.data.name ?? page.data.prefix ?? '';
		const parts = p ? p.split('/') : [];
		return parts.map((name, i) => ({
			name,
			href: i === parts.length - 1 && page.data.kind === 'page' ? null : `/ns/${encodeURI(parts.slice(0, i + 1).join('/'))}`
		}));
	});

	onMount(() => {
		try {
			treeOpen = localStorage.getItem('stichpunkt.tree') !== '0';
			panelOpen = localStorage.getItem('stichpunkt.panel') !== '0';
		} catch {
			/* private mode: both columns stay open */
		}
		if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js').catch(() => {});
		return listenForInstall();
	});
	afterNavigate(() => {
		ui.sheet = false;
		if (page.data.kind === 'page' && page.data.name) visit(page.data.name);
	});

	function remember(key: string, open: boolean) {
		try {
			localStorage.setItem(key, open ? '1' : '0');
		} catch {
			/* private mode */
		}
	}
	function toggleTree() {
		treeOpen = !treeOpen;
		remember('stichpunkt.tree', treeOpen);
	}
	function togglePanel() {
		panelOpen = !panelOpen;
		remember('stichpunkt.panel', panelOpen);
	}

	function typing(t: EventTarget | null) {
		const el = t as HTMLElement | null;
		return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
	}

	function onkey(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
			e.preventDefault();
			ui.switcher = ui.switcher ? null : 'switch';
		} else if (e.key === 'Escape' && ui.sheet) ui.sheet = false;
	}

	function back() {
		if (history.length > 1) history.back();
		else location.assign('/');
	}
</script>

<svelte:window onkeydown={onkey} />

<div class="app" class:tree-closed={!treeOpen} class:panel-closed={!panelOpen}>
	<header class="top">
		<button class="icon col-toggle" onclick={toggleTree} aria-label="Toggle navigation column" aria-pressed={treeOpen} title="Toggle navigation column"><Icon name="sidebar-left" size={18} /></button>
		<a class="brand" href="/" title={BRAND_TAGLINE}>{BRAND}<span class="brand-dot">.</span></a>
		<nav class="crumbs" aria-label="Breadcrumbs">
			{#each crumbs as c, i}
				{#if i > 0}<span class="sep">/</span>{/if}
				{#if c.href}<a href={c.href}>{c.name}</a>{:else}<span class="here">{c.name}</span>{/if}
			{/each}
		</nav>
		<button class="btn small search-btn" onclick={() => (ui.switcher = 'switch')} title="Quick switcher (Ctrl/Cmd-K)"><Icon name="search" size={14} /><span class="lbl">Search</span> <kbd>⌘K</kbd></button>
		{#if pwa.canInstall}<button class="btn small install-btn" onclick={install} title="Install as app">Install</button>{/if}
		<ThemeSwitch />
		<a class="icon gh" href={BRAND_REPO} target="_blank" rel="noopener noreferrer" aria-label="Source code on GitHub" title="Source code on GitHub"><Icon name="github" size={18} /></a>
		<button class="icon col-toggle right-toggle" onclick={togglePanel} aria-label="Toggle details column" aria-pressed={panelOpen} title="Toggle details column"><Icon name="sidebar-right" size={18} /></button>
	</header>

	<aside class="left">
		<Tree nodes={data.tree} {current} />
		<h2>Recent</h2>
		<ul class="recent">
			{#each data.recent as r (r.path)}<li><a href="/{encodeURI(r.path)}" title={r.path}>{r.title}</a></li>{/each}
		</ul>
		<h2>Tags</h2>
		<p class="taglist">
			{#each data.tags as t (t.name)}<a class="tag" href="/tag/{encodeURI(t.name)}">#{t.name}</a>{/each}
		</p>
	</aside>

	<main class="main">{#key page.url.pathname}<div class="main-inner">{@render children()}</div>{/key}
		<footer class="build muted" title={APP_COMMIT || 'unknown'}>v{APP_VERSION} · {shortCommit()} · <a href={BRAND_REPO} target="_blank" rel="noopener noreferrer">GitHub</a></footer>
	</main>

	<aside class="right">
		{#if view}<Panel {view} />{/if}
	</aside>

	<nav class="bar" aria-label="Primary">
		<button onclick={back}><span>←</span>Back</button>
		<a href="/" class="barlink"><span>⌂</span>Home</a>
		<button onclick={() => (ui.switcher = 'switch')}><span>⌕</span>Search</button>
		<button onclick={() => (ui.sheet = true)} disabled={!view}><span>⋯</span>More</button>
	</nav>

	{#if ui.sheet && view}
		<div class="overlay sheet-bg" role="presentation" onclick={() => (ui.sheet = false)}>
			<div class="sheet" role="dialog" aria-label="More" tabindex="-1" onclick={(e) => e.stopPropagation()}>
				<div class="grip"></div>
				<Panel {view} onnavigate={() => (ui.sheet = false)} />
			</div>
		</div>
	{/if}

	<Switcher />
	{#if ui.toast}<div class="toast" role="status">{ui.toast}</div>{/if}
</div>
