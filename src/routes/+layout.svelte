<script lang="ts">
	import '../app.css';
	import { BRAND, BRAND_REPO, BRAND_TAGLINE } from '#lib/brand';
	import { afterNavigate, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import Icon from '#lib/components/Icon.svelte';
	import ThemeSwitch from '#lib/components/ThemeSwitch.svelte';
	import Panel from '#lib/components/Panel.svelte';
	import Switcher from '#lib/components/Switcher.svelte';
	import Tree from '#lib/components/Tree.svelte';
	import Drawer from '#lib/components/Drawer.svelte';
	import LayerSwitch from '#lib/components/LayerSwitch.svelte';
	import { APP_VERSION, APP_COMMIT, shortCommit } from '#lib/version';
	import { startLive } from '#lib/client/live';
	import { storedLayerView, ui, visit } from '#lib/ui.svelte';
	import { install, listenForInstall, pwa } from '#lib/client/pwa.svelte';
	import { dismissUpdate, update, watchForUpdates } from '#lib/client/update.svelte';
	import { layerInView } from '#lib/layers';
	import { onMount } from 'svelte';

	type TreeNodeLike = { name: string; stub: string; path: string; layer?: string; page: boolean; children: TreeNodeLike[] };

	let { data, children } = $props();

	function filterTree(nodes: TreeNodeLike[]): TreeNodeLike[] {
		const out: TreeNodeLike[] = [];
		for (const node of nodes) {
			const children = filterTree(node.children ?? []);
			const pageVisible = node.page && layerInView(node.layer ?? 'reading', ui.layerView);
			if (pageVisible || children.length) out.push({ ...node, children });
		}
		return out;
	}
	const visibleTree = $derived(filterTree((data.tree ?? []) as unknown as TreeNodeLike[]));
	const visibleRecent = $derived((data.recent ?? []).filter((entry) => layerInView(entry.layer ?? 'reading', ui.layerView)));
	const layerLabels = $derived(data.layers?.labels ?? { reading: 'Notes', working: 'Working', config: 'Config', all: 'All' });
	const layersEnabled = $derived(data.layers?.enabled ?? false);

	const current = $derived(page.data.name ?? '');
	const view = $derived(page.data.kind === 'page' ? page.data.view : null);
	let treeOpen = $state(true);
	let panelOpen = $state(true);

	// breadcrumbs: every folder links to its namespace listing, the trailing crumb is the current page
	const parts = $derived<string[]>((page.data.name ?? page.data.prefix ?? '').split('/').filter(Boolean));
	const trail = $derived(parts.slice(0, -1).map((name, i) => ({ name, href: `/ns/${encodeURI(parts.slice(0, i + 1).join('/'))}` })));
	const here = $derived(parts.at(-1) ?? '');
	// tapping the current crumb opens the namespace it lives in
	const hereHref = $derived(
		page.data.kind === 'page'
			? parts.length > 1
				? `/ns/${encodeURI(parts.slice(0, -1).join('/'))}`
				: '/'
			: `/ns/${encodeURI(parts.join('/'))}`
	);

	const onSearch = $derived(page.url.pathname === '/search');
	const onHome = $derived(page.url.pathname === '/');

	let retryLive = $state<() => void>(() => {});

	onMount(() => {
		ui.layerView = storedLayerView();
		try {
			treeOpen = localStorage.getItem('stichpunkt.tree') !== '0';
			panelOpen = localStorage.getItem('stichpunkt.panel') !== '0';
		} catch {
			/* private mode: both columns stay open */
		}
		const live = startLive({ onChange: reload, onStatus: (on) => (ui.live = on) });
		retryLive = live.retry;
		if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js').catch(() => {});
		const stopInstall = listenForInstall();
		const stopUpdates = watchForUpdates();
		return () => {
			live.stop();
			stopInstall();
			stopUpdates();
		};
	});
	afterNavigate(() => {
		ui.sheet = false;
		ui.drawer = false;
		if (page.data.kind === 'page' && page.data.name) visit(page.data.name);
	});

	/** the reader has text selected in the content: a reload would throw the selection away */
	function selecting() {
		const s = getSelection();
		return !!s && !s.isCollapsed && !!s.anchorNode && !!document.querySelector('.main')?.contains(s.anchorNode);
	}

	let reloading = false;
	let again = false;
	let flashTimer: ReturnType<typeof setTimeout>;
	/** content changed on the server: reload the data, then flash what changed in the tree and the recent list */
	async function reload(paths: string[] | null) {
		if (selecting()) {
			const wait = () => {
				if (selecting()) return;
				document.removeEventListener('selectionchange', wait);
				void reload(paths);
			};
			document.addEventListener('selectionchange', wait);
			return;
		}
		if (reloading) {
			again = true;
			return;
		}
		reloading = true;
		try {
			await invalidateAll();
		} finally {
			reloading = false;
		}
		if (paths?.length) {
			ui.flash = new Set(paths);
			clearTimeout(flashTimer);
			flashTimer = setTimeout(() => (ui.flash = new Set()), 3500);
		}
		if (again) {
			again = false;
			void reload(null);
		}
	}

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

	/**
	 * The drawer owns one throwaway history entry, so a back gesture closes it instead of leaving the page.
	 * Deliberately the raw history API: SvelteKit's pushState/goto would run a navigation, and afterNavigate
	 * closes the drawer again. The copied state keeps SvelteKit's own entry shape, so its popstate handler
	 * just re-resolves the same URL. Dev builds log a one-time history_api_conflict warning for this.
	 */
	function openDrawer() {
		if (ui.drawer) return;
		ui.drawer = true;
		try {
			history.pushState({ ...history.state, mdwikiDrawer: true }, '', location.href);
		} catch {
			/* history is unavailable in some embedded browsers; the drawer still works */
		}
	}
	function closeDrawer(opts: { navigating?: boolean } = {}) {
		if (!ui.drawer) return;
		ui.drawer = false;
		// a navigation replaces the marker entry itself, so popping here would drop the previous page
		if (opts.navigating) return;
		// only pop our own entry: after a link navigation the state no longer carries the marker
		if ((history.state as { mdwikiDrawer?: boolean } | null)?.mdwikiDrawer) {
			try {
				history.back();
			} catch {
				/* nothing to pop */
			}
		}
	}
	function onpop() {
		if (ui.drawer) ui.drawer = false;
	}

	/** show a leading ellipsis on the breadcrumbs only when the trail is actually cut off */
	function clipHint(node: HTMLElement) {
		const trail = node.querySelector<HTMLElement>('.trail');
		// content aligned to the right overflows to the left, which scrollWidth does not report;
		// sum the children instead
		const update = () => {
			const width = trail ? [...trail.children].reduce((n, el) => n + (el as HTMLElement).offsetWidth, 0) : 0;
			node.classList.toggle('clipped', !!trail && width > trail.clientWidth + 1);
		};
		const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
		ro?.observe(node);
		if (trail) ro?.observe(trail);
		update();
		return { destroy: () => ro?.disconnect() };
	}

	function typing(t: EventTarget | null) {
		const el = t as HTMLElement | null;
		return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
	}

	function onkey(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
			e.preventDefault();
			ui.switcher = ui.switcher ? null : 'switch';
		} else if (e.key === 'Escape') {
			if (ui.sheet) ui.sheet = false;
			else if (ui.drawer) closeDrawer();
		}
	}
</script>

<svelte:window onkeydown={onkey} onpopstate={onpop} />

<div class="app" class:tree-closed={!treeOpen} class:panel-closed={!panelOpen}>
	<header class="top">
		<button class="icon col-toggle" onclick={toggleTree} aria-label="Toggle navigation column" aria-pressed={treeOpen} title="Toggle navigation column"><Icon name="sidebar-left" size={18} /></button>
		<a class="brand" href="/" title={BRAND_TAGLINE}>{BRAND}<span class="brand-dot">.</span></a>
		<nav class="crumbs" aria-label="Breadcrumbs" use:clipHint>
			<span class="lead" aria-hidden="true">…</span>
			<span class="trail">{#each trail as c}<a href={c.href}>{c.name}</a><span class="sep" aria-hidden="true">/</span>{/each}</span>
			{#if here}<a class="here" href={hereHref} aria-current="page" title={parts.join('/')}>{here}</a>{/if}
		</nav>
		<button class="btn small search-btn" onclick={() => (ui.switcher = 'switch')} title="Quick switcher (Ctrl/Cmd-K)" aria-label="Search or jump to a page"><Icon name="search" size={14} /><span class="lbl">Search</span> <kbd>⌘K</kbd></button>
		{#if pwa.canInstall}<button class="btn small install-btn" onclick={install} title="Install as app">Install</button>{/if}
		<ThemeSwitch />
		<a class="icon gh" href={BRAND_REPO} target="_blank" rel="noopener noreferrer" aria-label="Source code on GitHub" title="Source code on GitHub"><Icon name="github" size={18} /></a>
		<button class="icon col-toggle right-toggle" onclick={togglePanel} aria-label="Toggle details column" aria-pressed={panelOpen} title="Toggle details column"><Icon name="sidebar-right" size={18} /></button>
	</header>

	<aside class="left">
		<LayerSwitch labels={layerLabels} enabled={layersEnabled} />
		<Tree nodes={visibleTree} {current} />
		<h2>Recent</h2>
		<ul class="recent">
			{#each visibleRecent as r (r.path)}<li><a href="/{encodeURI(r.path)}" title={r.path} class:live-changed={ui.flash.has(r.path)}>{r.title}</a></li>{/each}
		</ul>
		<h2>Tags</h2>
		<p class="taglist">
			{#each data.tags as t (t.name)}<a class="tag" href="/tag/{encodeURI(t.name)}">#{t.name}</a>{/each}
		</p>
	</aside>

	<main class="main">{#key page.url.pathname}<div class="main-inner">{@render children()}</div>{/key}
		<footer class="build muted" title={APP_COMMIT || 'unknown'}>v{APP_VERSION} · {shortCommit()} · <a href={BRAND_REPO} target="_blank" rel="noopener noreferrer">GitHub</a> · <button
			type="button"
			class="live"
			class:on={ui.live}
			title={ui.live ? 'Live updates: connected' : 'Live updates: not connected - the page is still readable'}
			aria-label={ui.live ? 'Live updates: connected' : 'Live updates: not connected - the page is still readable'}
			onclick={() => retryLive()}
		><span class="live-dot" aria-hidden="true"></span>{ui.live ? 'live' : 'no live updates'}</button></footer>
	</main>

	<aside class="right">
		{#if view}<Panel {view} />{/if}
	</aside>

	<nav class="bar" aria-label="Primary">
		<button class="barbtn" class:active={ui.drawer} aria-expanded={ui.drawer} aria-controls="mobile-drawer" onclick={openDrawer}><Icon name="menu" size={20} /><span class="blabel">Browse</span></button>
		<button class="barbtn" class:active={onSearch} onclick={() => (ui.switcher = 'switch')}><Icon name="search" size={20} /><span class="blabel">Search</span></button>
		<a href="/" class="barlink" class:active={onHome} aria-current={onHome ? 'page' : undefined}><Icon name="home" size={20} /><span class="blabel">Home</span></a>
		<button class="barbtn" class:active={ui.sheet} aria-expanded={ui.sheet} onclick={() => (ui.sheet = true)} disabled={!view}><Icon name="more" size={20} /><span class="blabel">More</span></button>
	</nav>

	{#if ui.drawer}
		<Drawer tree={visibleTree} recent={visibleRecent} tags={data.tags} layerLabels={layerLabels} layersEnabled={layersEnabled} {current} onclose={closeDrawer} />
	{/if}

	{#if ui.sheet && view}
		<div class="overlay sheet-bg" role="presentation" onclick={() => (ui.sheet = false)}>
			<!-- svelte-ignore a11y_click_events_have_key_events -- onclick only stops propagation to the scrim; not a user action -->
			<div class="sheet" role="dialog" aria-label="More" tabindex="-1" onclick={(e) => e.stopPropagation()}>
				<div class="grip"></div>
				<Panel {view} onnavigate={() => (ui.sheet = false)} />
			</div>
		</div>
	{/if}

	<Switcher />
	{#if update.available && !update.dismissed}
		<div class="update-hint" role="status">
			<span>New version available</span>
			<button class="update-action" onclick={() => location.reload()}>Reload</button>
			<button class="update-dismiss" aria-label="Dismiss" onclick={() => dismissUpdate()}>×</button>
		</div>
	{/if}
	{#if ui.toast}<div class="toast" role="status">{ui.toast}{#if ui.toastAction}<button class="toast-action" onclick={() => (ui.toastAction?.run(), (ui.toast = ''), (ui.toastAction = null))}>{ui.toastAction.label}</button>{/if}</div>{/if}
</div>
