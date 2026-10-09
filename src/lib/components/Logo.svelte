<script lang="ts">
	/**
	 * The stichpunkt mark: three bullet points joined by a dotted stitch, the first
	 * in the accent colour. Draws with the theme colours, so it works on light and
	 * dark backgrounds (unlike the rasterised tile in static/).
	 */
	let { size = 40, title = 'stichpunkt' }: { size?: number; title?: string } = $props();
</script>

<svg class="mark" width={size} height={size} viewBox="0 0 512 512" role="img" aria-label={title}>
	<g class="mark-ink">
		<circle cx="148" cy="256" r="24" />
		<path d="M200 256h130" />
		<circle cx="148" cy="342" r="24" />
		<path d="M200 342h160" />
	</g>
	<g class="mark-accent">
		<circle cx="148" cy="170" r="24" />
		<path d="M200 170h190" />
	</g>
	<g class="mark-stitch">
		<circle cx="148" cy="203" r="4.5" />
		<circle cx="148" cy="213" r="4.5" />
		<circle cx="148" cy="223" r="4.5" />
		<circle cx="148" cy="289" r="4.5" />
		<circle cx="148" cy="299" r="4.5" />
		<circle cx="148" cy="309" r="4.5" />
	</g>
</svg>

<style>
	.mark { display: block; flex: none; }
	.mark circle { stroke: none; }
	.mark path { fill: none; stroke-width: 28; stroke-linecap: round; }
	.mark-ink circle { fill: var(--fg); }
	.mark-ink path { stroke: var(--fg); }
	.mark-accent circle { fill: var(--accent); }
	.mark-accent path { stroke: var(--accent); }
	.mark-stitch circle { fill: var(--muted); }
</style>
