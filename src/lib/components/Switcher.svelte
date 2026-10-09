<script lang="ts">
	import { goto } from '$app/navigation';
	import { rank, type Titled } from '#lib/fuzzy';
	import { recentPages, ui } from '#lib/ui.svelte';
	import { tick } from 'svelte';

	let q = $state('');
	let items = $state<Titled[]>([]);
	let sel = $state(0);
	let input: HTMLInputElement | undefined = $state();
	const mode = $derived(ui.switcher);

	$effect(() => {
		if (!mode) return;
		q = '';
		sel = 0;
		fetch('/_ui/titles')
			.then((r) => r.json())
			.then((t) => (items = t))
			.catch(() => {});
		tick().then(() => input?.focus());
	});

	const matches = $derived(mode === 'switch' ? rank(items, q, recentPages(), 12) : []);
	type Row = { label: string; hint?: string; go: () => void };
	const rows = $derived.by<Row[]>(() => {
		const name = q.trim().replace(/^\/+|\/+$/g, '');
		const out: Row[] = [];
		if (mode === 'switch') {
			for (const m of matches) out.push({ label: m.title, hint: m.path !== m.title ? m.path : undefined, go: () => open(`/${encodeURI(m.path)}`) });
			if (name) out.push({ label: `Search text for "${name}"`, hint: 'full-text', go: () => open(`/search?q=${encodeURIComponent(name)}`) });
		}
		return out;
	});

	function open(href: string) {
		ui.switcher = null;
		goto(href);
	}

	function key(e: KeyboardEvent) {
		if (e.key === 'Escape') ui.switcher = null;
		else if (e.key === 'ArrowDown') (e.preventDefault(), (sel = Math.min(sel + 1, rows.length - 1)));
		else if (e.key === 'ArrowUp') (e.preventDefault(), (sel = Math.max(sel - 1, 0)));
		else if (e.key === 'Enter') (e.preventDefault(), rows[sel]?.go());
	}
</script>

{#if mode}
	<div class="overlay" role="presentation" onclick={() => (ui.switcher = null)}>
		<div class="switcher" role="dialog" aria-label="Quick switcher" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={key}>
			<input
				bind:this={input}
				bind:value={q}
				oninput={() => (sel = 0)}
				placeholder="Jump to page…"
				autocapitalize="off"
				autocomplete="off"
				spellcheck="false"
				enterkeyhint="go"
			/>
			<ul>
				{#each rows as r, i}
					<li><button class:sel={i === sel}  onmouseenter={() => (sel = i)} onclick={r.go}>{r.label}{#if r.hint}<span class="muted"> {r.hint}</span>{/if}</button></li>
				{:else}
					<li class="muted pad">No matching pages</li>
				{/each}
			</ul>
		</div>
	</div>
{/if}
