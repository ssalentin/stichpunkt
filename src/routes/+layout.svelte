<script lang="ts">
	import '../app.css';
	import { BRAND, BRAND_TAGLINE } from '#lib/brand';
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import Panel from '#lib/components/Panel.svelte';
	import Switcher from '#lib/components/Switcher.svelte';
	import Tree from '#lib/components/Tree.svelte';
	import { APP_VERSION, APP_COMMIT, shortCommit } from '#lib/version';
	import { THEMES, setTheme, storedTheme, type Theme } from '#lib/client/theme';
	import { ui, visit } from '#lib/ui.svelte';
	import { onMount } from 'svelte';

	let { data, children } = $props();

	const current = $derived(page.data.name ?? '');
	const view = $derived(page.data.kind === 'page' ? page.data.view : null);
	let treeOpen = $state(true);
	let theme = $state<Theme>('system');

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
		theme = storedTheme();
		treeOpen = localStorage.getItem('stichpunkt.tree') !== '0';
		if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js').catch(() => {});
	});
	afterNavigate(() => {
		ui.sheet = false;
		if (page.data.kind === 'page' && page.data.name) visit(page.data.name);
	});

	function toggleTree() {
		treeOpen = !treeOpen;
		localStorage.setItem('stichpunkt.tree', treeOpen ? '1' : '0');
	}

	function onTheme(e: Event) {
		theme = (e.currentTarget as HTMLSelectElement).value as Theme;
		setTheme(theme);
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

<div class="app" class:tree-closed={!treeOpen}>
	<header class="top">
		<button class="icon" onclick={toggleTree} aria-label="Toggle sidebar" title="Toggle sidebar">☰</button>
		<a class="brand" href="/" title={BRAND_TAGLINE}>{BRAND}<span class="brand-dot">.</span></a>
		<nav class="crumbs" aria-label="Breadcrumbs">
			{#each crumbs as c, i}
				{#if i > 0}<span class="sep">/</span>{/if}
				{#if c.href}<a href={c.href}>{c.name}</a>{:else}<span class="here">{c.name}</span>{/if}
			{/each}
		</nav>
		<select class="theme-select" value={theme} onchange={onTheme} aria-label="Theme" title="Theme">
			{#each THEMES as t}<option value={t.value}>{t.label}</option>{/each}
		</select>
		<button class="btn small" onclick={() => (ui.switcher = 'switch')} title="Quick switcher (Ctrl/Cmd-K)">Search <kbd>⌘K</kbd></button>
	</header>

	<aside class="left">
		<Tree nodes={data.tree} {current} />
		<h3>Recent</h3>
		<ul class="recent">
			{#each data.recent as r (r.path)}<li><a href="/{encodeURI(r.path)}" title={r.path}>{r.title}</a></li>{/each}
		</ul>
		<h3>Tags</h3>
		<p class="taglist">
			{#each data.tags as t (t.name)}<a class="tag" href="/tag/{encodeURI(t.name)}">#{t.name}</a>{/each}
		</p>
	</aside>

	<main class="main">{#key page.url.pathname}<div class="main-inner">{@render children()}</div>{/key}
		<footer class="build muted" title={APP_COMMIT || 'unknown'}>v{APP_VERSION} · {shortCommit()}</footer>
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
