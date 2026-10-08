<script lang="ts">
	import { beforeNavigate, goto, invalidate } from '$app/navigation';
	import { api, toast, ui } from '#lib/ui.svelte';
	import { onDestroy, onMount } from 'svelte';
	import type { EditorView } from '@codemirror/view';

	let { path, initial, baseHash }: { path: string; initial: string; baseHash: string } = $props();

	let host: HTMLDivElement;
	let view: EditorView | undefined;
	// svelte-ignore state_referenced_locally
	let base = $state(baseHash);
	let saving = $state(false);
	let dirty = $state(false);
	let savedAt = $state('');
	let focused = $state(false);
	let kb = $state(0);
	let conflict = $state<null | { mine: string; theirs: { content: string; hash: string } | null }>(null);
	let cm: typeof import('./cm') | undefined;
	let photo: HTMLInputElement, file: HTMLInputElement;

	const pageUrl = () => `/${encodeURI(path)}`;

	const handle = {
		get saving() { return saving; },
		get dirty() { return dirty; },
		get focused() { return focused; },
		save: () => void save(),
		exit
	};

	function exit() {
		if (dirty && !confirm('Discard unsaved changes?')) return;
		dirty = false;
		goto(pageUrl());
	}

	async function save(overwrite?: { hash: string | null }) {
		if (!view || saving) return;
		const content = view.state.doc.toString();
		saving = true;
		const sendBase = overwrite ? (overwrite.hash ?? '') : base;
		const r = await api('PUT', '/_ui/page', { path, content, base_hash: sendBase });
		saving = false;
		if (r.status === 200) {
			base = r.data.hash;
			dirty = false;
			conflict = null;
			savedAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
			toast('Saved');
			await invalidate('app:space');
		} else if (r.status === 409) {
			conflict = { mine: content, theirs: r.data.current ?? null };
		} else {
			toast(r.data?.message ?? `Save failed (${r.status})`);
		}
	}

	function useTheirs() {
		if (!conflict || !view) return;
		const t = conflict.theirs;
		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t?.content ?? '' } });
		base = t?.hash ?? '';
		dirty = false;
		conflict = null;
	}

	async function upload(input: HTMLInputElement) {
		const f = input.files?.[0];
		input.value = '';
		if (!f || !view) return;
		const form = new FormData();
		form.set('page', path);
		form.set('file', f);
		toast('Uploading…');
		const r = await api('POST', '/_ui/upload', form);
		if (r.status === 200) {
			cm!.insert(view, r.data.markdown + '\n');
			toast('Uploaded');
		} else toast(r.data?.message ?? 'Upload failed');
	}

	function viewport() {
		const vv = window.visualViewport;
		kb = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
	}

	beforeNavigate(({ willUnload, cancel }) => {
		if (dirty && willUnload) cancel();
	});

	onMount(async () => {
		cm = await import('./cm');
		view = await cm.create(host, initial, {
			onChange: () => (dirty = true),
			onFocus: (f) => (focused = f),
			onSave: () => void save(),
			onExit: exit
		});
		window.visualViewport?.addEventListener('resize', viewport);
		window.visualViewport?.addEventListener('scroll', viewport);
		ui.editor = handle as typeof ui.editor;
		if (!initial) view.focus();
	});

	onDestroy(() => {
		window.visualViewport?.removeEventListener('resize', viewport);
		window.visualViewport?.removeEventListener('scroll', viewport);
		view?.destroy();
		ui.editor = null;
	});
</script>

<svelte:window onbeforeunload={(e) => dirty && e.preventDefault()} />

<div class="editor-wrap">
	<div class="editor-head muted">
		Editing <strong>{path}</strong>{base === '' ? ' (new page)' : ''}
		{#if dirty}<span class="dirty">● unsaved</span>{:else if savedAt}<span>saved {savedAt}</span>{/if}
	</div>

	{#if conflict}
		<div class="conflict" role="alert">
			<h2>Save conflict</h2>
			<p>
				{#if conflict.theirs}This page was changed by someone else after you opened it. Nothing was overwritten.
				{:else}This page was deleted or moved after you opened it.{/if}
			</p>
			<div class="versions">
				<div><h3>Your version</h3><pre>{conflict.mine}</pre></div>
				<div><h3>Current version on disk</h3><pre>{conflict.theirs?.content ?? '(page no longer exists)'}</pre></div>
			</div>
			<p class="row">
				<button class="btn" onclick={useTheirs}>Use current version (discard mine)</button>
				<button class="btn danger" onclick={() => save({ hash: conflict?.theirs?.hash ?? null })}>Overwrite with mine</button>
				<button class="btn" onclick={() => (conflict = null)}>Keep editing</button>
			</p>
		</div>
	{/if}

	<div class="cm-host" bind:this={host} class:hidden={!!conflict}></div>

	<div class="mtoolbar" style="bottom: {kb}px" class:show={focused}>
		<button onpointerdown={(e) => e.preventDefault()} onclick={() => view && cm?.wikilink(view)}>[[ ]]</button>
		<button onpointerdown={(e) => e.preventDefault()} onclick={() => view && cm?.task(view)}>☐</button>
		<button onpointerdown={(e) => e.preventDefault()} onclick={() => view && cm?.heading(view)}>#</button>
		<button onpointerdown={(e) => e.preventDefault()} onclick={() => view && cm?.indent(view, 1)}>→</button>
		<button onpointerdown={(e) => e.preventDefault()} onclick={() => view && cm?.indent(view, -1)}>←</button>
		<button onpointerdown={(e) => e.preventDefault()} onclick={() => view && cm?.list(view)}>•</button>
		<button onpointerdown={(e) => e.preventDefault()} onclick={() => view && cm?.undo(view)}>↶</button>
		<button onpointerdown={(e) => e.preventDefault()} onclick={() => photo.click()}>📷</button>
	</div>
	<p class="row tools">
		<button class="btn small" onclick={() => photo.click()}>Photo</button>
		<button class="btn small" onclick={() => file.click()}>Attach file</button>
	</p>
	<input bind:this={photo} type="file" accept="image/*" capture="environment" hidden onchange={() => upload(photo)} />
	<input bind:this={file} type="file" accept="image/*,application/pdf,.txt,.csv,.json" hidden onchange={() => upload(file)} />
</div>
