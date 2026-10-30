<script lang="ts">
	import type { LayerView } from '#lib/layers';
	import { setLayerView, ui } from '#lib/ui.svelte';

	let { labels, enabled = false }: { labels: Record<string, string>; enabled?: boolean } = $props();

	const options: { view: LayerView; label: string }[] = $derived([
		{ view: 'reading', label: labels.reading ?? 'Notes' },
		{ view: 'working', label: labels.working ?? 'Working' },
		{ view: 'all', label: 'All' }
	]);
</script>

{#if enabled}
<div class="layer-switch" role="group" aria-label="Page layers">
	{#each options as option (option.view)}
		<button
			type="button"
			class:active={ui.layerView === option.view}
			aria-pressed={ui.layerView === option.view}
			onclick={() => setLayerView(option.view)}
		>{option.label}</button>
	{/each}
</div>
{/if}
