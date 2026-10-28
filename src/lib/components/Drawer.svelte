<script lang="ts">
	import { BRAND_REPO } from '#lib/brand';
	import Icon from './Icon.svelte';
	import ThemeSwitch from './ThemeSwitch.svelte';
	import Tree from './Tree.svelte';
	import { ui } from '#lib/ui.svelte';
	import { onMount } from 'svelte';

	interface Node {
		name: string;
		stub: string;
		path: string;
		page: boolean;
		children: Node[];
	}

	let {
		tree,
		recent,
		tags,
		current,
		onclose
	}: {
		tree: Node[];
		recent: { path: string; title: string }[];
		tags: { name: string }[];
		current: string;
		onclose: () => void;
	} = $props();

	let panel = $state<HTMLElement>();

	onMount(() => {
		const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const scroll = window.scrollY;
		document.body.style.overflow = 'hidden';
		panel?.focus();
		return () => {
			document.body.style.overflow = '';
			window.scrollTo(0, scroll);
			restore?.focus();
		};
	});

	/** cycle focus inside the dialog, so the page behind it stays unreachable */
	function trap(e: KeyboardEvent) {
		if (e.key !== 'Tab' || !panel) return;
		const items = [...panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])')].filter(
			(el) => el.offsetParent !== null
		);
		if (!items.length) return;
		const first = items[0];
		const last = items[items.length - 1];
		const active = document.activeElement;
		if (e.shiftKey && (active === first || active === panel)) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && active === last) {
			e.preventDefault();
			first.focus();
		}
	}

	function openSearch() {
		onclose();
		ui.switcher = 'switch';
	}
</script>

<div class="drawer-layer" role="presentation" onclick={onclose}>
	<!-- svelte-ignore a11y_click_events_have_key_events -- the click only stops propagation to the scrim -->
	<div
		class="drawer"
		id="mobile-drawer"
		role="dialog"
		aria-modal="true"
		aria-label="Browse"
		tabindex="-1"
		bind:this={panel}
		onclick={(e) => e.stopPropagation()}
		onkeydown={trap}
	>
		<div class="drawer-head">
			<button class="drawer-search" type="button" onclick={openSearch}>
				<Icon name="search" size={16} />
				<span>Search or jump to…</span>
			</button>
			<button class="drawer-close" type="button" aria-label="Close navigation" onclick={onclose}>
				<Icon name="close" size={18} />
			</button>
		</div>

		<div class="drawer-body">
			<h2>Pages</h2>
			<nav aria-label="Page tree"><Tree nodes={tree} {current} /></nav>
			<h2>Recent</h2>
			<ul class="recent">
				{#each recent as r (r.path)}
					<li><a href="/{encodeURI(r.path)}" title={r.path} class:live-changed={ui.flash.has(r.path)}>{r.title}</a></li>
				{/each}
			</ul>
			<h2>Tags</h2>
			<p class="taglist">
				{#each tags as t (t.name)}<a class="tag" href="/tag/{encodeURI(t.name)}">#{t.name}</a>{/each}
			</p>
		</div>

		<div class="drawer-foot">
			<ThemeSwitch />
			<a class="drawer-gh" href={BRAND_REPO} target="_blank" rel="noopener noreferrer"><Icon name="github" size={16} /> Source on GitHub</a>
		</div>
	</div>
</div>
