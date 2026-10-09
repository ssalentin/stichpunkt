<script lang="ts">
	import { toast } from '#lib/ui.svelte';
	import { copyText } from '#lib/client/clipboard';

	interface View {
		path: string;
		headings: { level: number; text: string; slug: string }[];
		backlinks: { path: string; title: string; count: number }[];
		tags: string[];
		frontmatter?: Record<string, unknown>;
	}
	let { view, onnavigate }: { view: View; onnavigate?: () => void } = $props();

	const props = $derived(Object.entries(view.frontmatter ?? {}));
	const fmt = (v: unknown) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));

	async function copyLink() {
		toast((await copyText(`[[${view.path}]]`)) ? 'Wikilink copied' : 'Copy failed: clipboard is blocked by the browser');
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
				<li><a href="/{encodeURI(b.path)}" title={b.path} onclick={() => onnavigate?.()}>{b.title}</a></li>
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
{#if props.length}
	<section class="props-panel">
		<h3>Properties</h3>
		<dl>
			{#each props as [k, v]}
				<dt>{k}</dt>
				<dd>{fmt(v)}</dd>
			{/each}
		</dl>
	</section>
{/if}
<section class="actions">
	<h3>Page</h3>
	<button class="btn" onclick={copyLink}>Copy [[link]]</button>
</section>
