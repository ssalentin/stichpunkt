<script lang="ts">
	type Name = 'sun' | 'moon' | 'auto' | 'github' | 'search' | 'sidebar-left' | 'sidebar-right' | 'file' | 'text' | 'enter';
	let { name, size = 16 }: { name: Name; size?: number } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
	{#if name === 'sun'}
		<circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
	{:else if name === 'moon'}
		<path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z" />
	{:else if name === 'auto'}
		<rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" />
	{:else if name === 'github'}
		<path fill="currentColor" stroke="none" d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.69 1.25 3.34.96.1-.74.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.18 1.83 1.18 3.09 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z" />
	{:else if name === 'search'}
		<circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
	{:else if name === 'sidebar-left'}
		<rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" />
	{:else if name === 'sidebar-right'}
		<rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" />
	{:else if name === 'file'}
		<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" />
	{:else if name === 'text'}
		<path d="M4 6h16M4 12h16M4 18h10" />
	{:else if name === 'enter'}
		<path d="M20 5v7a2 2 0 0 1-2 2H5" /><path d="m9 10-4 4 4 4" />
	{/if}
</svg>
