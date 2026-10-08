<script lang="ts">
	import { goto, invalidate } from '$app/navigation';
	import { api, toast, ui } from '#lib/ui.svelte';

	interface View {
		path: string;
		headings: { level: number; text: string; slug: string }[];
		backlinks: { path: string; title: string; count: number }[];
		tags: string[];
	}
	let { view, onnavigate }: { view: View; onnavigate?: () => void } = $props();

	async function remove() {
		if (!confirm(`Delete "${view.path}"? This cannot be undone.`)) return;
		const r = await api('DELETE', '/_ui/page', { path: view.path });
		if (r.status === 200) {
			await invalidate('app:space');
			await goto('/');
		} else toast(r.data?.message ?? 'Delete failed');
		onnavigate?.();
	}

	async function copyLink() {
		try {
			await navigator.clipboard.writeText(`[[${view.path}]]`);
			toast('Wikilink copied');
		} catch {
			toast('Copy not available');
		}
	}
</script>

<section>
	<h3>Outline</h3>
	{#if view.headings.length}
		<ul class="outline">
			{#each view.headings as h}
				<li style="padding-left: {(h.level - 1) * 0.8}rem"><a href="#{h.slug}" onclick={() => onnavigate?.()}>{h.text}</a></li>
			{/each}
		</ul>
	{:else}<p class="muted">No headings</p>{/if}
</section>
<section>
	<h3>Backlinks <span class="muted">{view.backlinks.length}</span></h3>
	{#if view.backlinks.length}
		<ul>
			{#each view.backlinks as b}
				<li><a href="/{encodeURI(b.path)}" onclick={() => onnavigate?.()}>{b.path}</a></li>
			{/each}
		</ul>
	{:else}<p class="muted">Nothing links here</p>{/if}
</section>
<section>
	<h3>Tags</h3>
	<p class="taglist">
		{#each view.tags as t}<a class="tag" href="/tag/{encodeURI(t)}" onclick={() => onnavigate?.()}>#{t}</a>{:else}<span class="muted">No tags</span>{/each}
	</p>
</section>
<section class="actions">
	<h3>Page</h3>
	<a class="btn" href="/{encodeURI(view.path)}?edit=1" onclick={() => onnavigate?.()}>Edit</a>
	<button class="btn" onclick={copyLink}>Copy [[link]]</button>
	<button class="btn danger" onclick={remove} disabled={!!ui.editor}>Delete</button>
</section>
