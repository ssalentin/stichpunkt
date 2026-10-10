<script lang="ts">
	import Icon from './Icon.svelte';
	import { THEMES, setTheme, storedTheme, type Theme } from '#lib/client/theme';
	import { onMount } from 'svelte';

	let theme = $state<Theme>('system');
	const icons = { system: 'auto', light: 'sun', dark: 'moon' } as const;

	onMount(() => (theme = storedTheme()));

	function pick(t: Theme) {
		theme = t;
		setTheme(t);
	}

	/** arrow keys move through the group like a native radio group */
	function key(e: KeyboardEvent) {
		const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
		if (!step) return;
		e.preventDefault();
		const next = THEMES[(THEMES.findIndex((t) => t.value === theme) + step + THEMES.length) % THEMES.length];
		pick(next.value);
		(e.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-theme-value="${next.value}"]`)?.focus();
	}
</script>

<div class="theme-switch" role="radiogroup" aria-label="Theme" tabindex="-1" onkeydown={key}>
	{#each THEMES as t (t.value)}
		<button
			type="button"
			role="radio"
			aria-checked={theme === t.value}
			aria-label={t.label}
			title={t.label}
			data-theme-value={t.value}
			tabindex={theme === t.value ? 0 : -1}
			class:on={theme === t.value}
			onclick={() => pick(t.value)}
		><Icon name={icons[t.value]} size={15} /></button>
	{/each}
</div>
