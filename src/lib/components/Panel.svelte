<script lang="ts">
		import { toast } from '#lib/ui.svelte';

	interface View {
		path: string;
		headings: { level: number; text: string; slug: string }[];
		backlinks: { path: string; title: string; count: number }[];
		tags: string[];
	}
	let { view, onnavigate }: { view: View; onnavigate?: () => void } = $props();

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
	<button class="btn" onclick={copyLink}>Copy [[link]]</button>
</section>
