<script lang="ts">
	import Self from './Tree.svelte';

	interface Node {
		name: string;
		path: string;
		page: boolean;
		children: Node[];
	}
	let { nodes, current }: { nodes: Node[]; current: string } = $props();
</script>

<ul class="tree">
	{#each nodes as n (n.path)}
		<li>
			{#if n.children.length}
				<details open={current === n.path || current.startsWith(n.path + '/')}>
					<summary>
						{#if n.page}<a href="/{encodeURI(n.path)}" class:active={current === n.path}>{n.name}</a>
						{:else}<a href="/ns/{encodeURI(n.path)}" class="folder">{n.name}/</a>{/if}
					</summary>
					<Self nodes={n.children} {current} />
				</details>
			{:else}
				<a href="/{encodeURI(n.path)}" class:active={current === n.path}>{n.name}</a>
			{/if}
		</li>
	{/each}
</ul>
