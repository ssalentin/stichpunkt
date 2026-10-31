<script lang="ts">
	import { BRAND } from '#lib/brand';

	let { data } = $props();
	const m = $derived(data.manifest);

	const state = $derived(!m.exists ? 'missing' : !m.valid ? 'invalid' : m.issues.length ? 'warn' : 'ok');
	const stateLabel = $derived(
		state === 'missing' ? 'No manifest' : state === 'invalid' ? 'Invalid' : state === 'warn' ? 'Active · warnings' : 'Active'
	);

	type RuleRow = { key: string; value: string };
	function pageRules(rules: NonNullable<typeof m.rules>): RuleRow[] {
		const p = rules.pages;
		if (!p) return [];
		const rows: RuleRow[] = [];
		if (p.required_frontmatter?.length) rows.push({ key: 'Required frontmatter', value: p.required_frontmatter.join(', ') });
		if (p.allowed_tags?.length) rows.push({ key: 'Allowed tags', value: p.allowed_tags.map((t) => `#${t}`).join(', ') });
		if (p.forbidden_prefixes?.length) rows.push({ key: 'Forbidden prefixes', value: p.forbidden_prefixes.join(', ') });
		if (p.stand_field) rows.push({ key: 'Stand field', value: p.stand_field });
		if (p.stand_max_age_days) rows.push({ key: 'Stand max age', value: `${p.stand_max_age_days} days` });
		if (p.require_agent) rows.push({ key: 'Actor required', value: 'yes' });
		return rows;
	}
</script>

<svelte:head><title>Manifest · {BRAND}</title></svelte:head>

<article class="page manifest">
	<header class="mhead">
		<div>
			<p class="eyebrow">System</p>
			<h1>Manifest</h1>
		</div>
		<span class="state {state}">{stateLabel}</span>
	</header>

	<p class="muted intro">
		The manifest is this space's rulebook: it defines folders, layers, checks and the summary every agent receives.
		It is a fixed system page. Agents change it in place through <code>write_page("MANIFEST", …)</code>; it cannot be
		moved or deleted, and an invalid version is never applied.
	</p>

	{#if !m.exists}
		<p class="notice">This space has no manifest. The app runs with its defaults; agents see no space rules.</p>
	{:else}
		{#if m.stale}
			<p class="notice bad" role="alert">
				The file on disk is invalid, so its rules are <strong>not</strong> active. The last valid version keeps working until the
				file is fixed.
			</p>
		{/if}
		{#if state === 'invalid'}
			<p class="notice bad" role="alert">The manifest is invalid and no earlier valid version is active. Agents see no space rules.</p>
		{/if}

		<dl class="facts">
			<div><dt>Source</dt><dd><a href="/MANIFEST">MANIFEST</a></dd></div>
			<div><dt>Version</dt><dd><code>{m.hash.slice(0, 10)}</code></dd></div>
			<div><dt>Changed</dt><dd>{new Date(m.mtimeMs).toLocaleString()}</dd></div>
			{#if m.stand}<div><dt>Stand</dt><dd>{m.stand}</dd></div>{/if}
			<div><dt>Space</dt><dd>{m.counts.pages} pages · {m.counts.folders} folders</dd></div>
		</dl>

		{#if m.issues.length}
			<section class="block">
				<h2>{m.valid ? 'Warnings' : 'Issues'}</h2>
				<ul class="issues">
					{#each m.issues as issue}<li><code>{issue.path}</code> {issue.message}</li>{/each}
				</ul>
				{#if m.valid}<p class="muted">Warnings do not block writes; they point at rules that do not match the space yet.</p>{/if}
			</section>
		{/if}

		{#if m.rules}
			<section class="block">
				<h2>Summary</h2>
				<p class="summary">{m.rules.summary}</p>
			</section>

			<section class="block">
				<h2>Folders</h2>
				{#if m.folders.length}
					<div class="scroll">
						<table>
							<thead><tr><th>Folder</th><th>Owner</th><th>Layer</th><th>Pages</th><th>Description</th></tr></thead>
							<tbody>
								{#each m.folders as folder (folder.name)}
									<tr>
										<td><a href="/ns/{encodeURI(folder.name)}">{folder.name}/</a></td>
										<td>{folder.owner ?? '—'}</td>
										<td>{m.labels[folder.layer] ?? folder.layer}</td>
										<td>{folder.pages}</td>
										<td class="muted">{folder.description ?? ''}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{:else}
					<p class="muted">No folders declared.</p>
				{/if}
			</section>

			{@const ruleRows = pageRules(m.rules)}
			{#if ruleRows.length}
				<section class="block">
					<h2>Page rules</h2>
					<dl class="facts rules">
						{#each ruleRows as row (row.key)}<div><dt>{row.key}</dt><dd>{row.value}</dd></div>{/each}
					</dl>
				</section>
			{/if}

			<section class="block">
				<h2>Layers</h2>
				<div class="scroll">
					<table>
						<thead><tr><th>Layer</th><th>Label</th><th>Checks</th><th>Overrides</th></tr></thead>
						<tbody>
							{#each m.layers as layer (layer.layer)}
								<tr>
									<td><code>{layer.layer}</code></td>
									<td>{layer.label ?? m.labels[layer.layer]}</td>
									<td>{layer.checks ? layer.checks.join(', ') || 'none' : 'inherited'}</td>
									<td>{layer.hasOverrides ? 'yes' : '—'}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>

			{#if Object.keys(m.pagesMap).length}
				<section class="block">
					<h2>Page overrides</h2>
					<div class="scroll">
						<table>
							<thead><tr><th>Page</th><th>Layer</th></tr></thead>
							<tbody>
								{#each Object.entries(m.pagesMap) as [page, layer] (page)}<tr><td><code>{page}</code></td><td>{m.labels[layer] ?? layer}</td></tr>{/each}
							</tbody>
						</table>
					</div>
				</section>
			{/if}

			<section class="block">
				<h2>Checks</h2>
				{#if m.rules.checks?.length}
					<p class="chips">{#each m.rules.checks as check (check)}<span class="chip">{check}</span>{/each}</p>
				{:else}
					<p class="muted">No checks enabled.</p>
				{/if}
				{#if m.rules.viewLabels?.all}<p class="muted">Third sidebar view is labelled “{m.rules.viewLabels.all}”.</p>{/if}
			</section>

			{#if m.rules.actors && Object.keys(m.rules.actors).length}
				<section class="block">
					<h2>Actors</h2>
					<p class="chips">{#each Object.entries(m.rules.actors) as [slug, actor] (slug)}<span class="chip">{actor.name} · {slug}</span>{/each}</p>
				</section>
			{/if}

			<section class="block">
				<h2>Rules in prose</h2>
				<div class="md">{@html m.proseHtml}</div>
			</section>

			<details class="block raw">
				<summary>Frontmatter (YAML)</summary>
				<pre><code>{m.yaml}</code></pre>
			</details>
		{/if}
	{/if}
</article>

<style>
	.manifest { max-width: 78ch; }
	.mhead { display: flex; align-items: flex-end; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
	.eyebrow { margin: 0; font: 700 0.72rem var(--mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }
	.mhead h1 { margin: 0.15rem 0 0.6rem; }
	.intro { margin: 0 0 1.2rem; }
	.state { padding: 3px 9px; border: 1px solid var(--border); border-radius: 999px; font: 700 0.72rem var(--sans); text-transform: uppercase; letter-spacing: 0.05em; }
	.state.ok { color: var(--link); border-color: var(--link); }
	.state.warn { color: var(--accent); border-color: var(--accent); }
	.state.invalid, .state.bad { color: var(--danger); border-color: var(--danger); }
	.state.missing { color: var(--muted); }
	.notice { padding: 0.6rem 0.8rem; border-left: 3px solid var(--accent); background: var(--panel); }
	.notice.bad { border-left-color: var(--danger); }
	.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: 0.5rem 1rem; margin: 1rem 0; }
	.facts div { display: flex; flex-direction: column; min-width: 0; }
	.facts dt { font: 700 0.7rem var(--mono); text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
	.facts dd { margin: 0; overflow-wrap: anywhere; }
	.rules { grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); }
	.block { margin: 1.8rem 0; }
	.block h2 { font-size: 0.8rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin: 0 0 0.6rem; }
	.summary { border-left: 3px solid var(--border); padding-left: 0.8rem; margin: 0; }
	.scroll { overflow-x: auto; }
	table { border-collapse: collapse; width: 100%; font-size: 0.92rem; }
	th, td { text-align: left; padding: 0.35rem 0.7rem 0.35rem 0; border-bottom: 1px solid var(--border); vertical-align: top; }
	th { font: 700 0.7rem var(--mono); text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
	.issues { margin: 0; padding-left: 1.1rem; }
	.issues li { margin: 0.25rem 0; }
	.chips { display: flex; flex-wrap: wrap; gap: 0.4rem; }
	.chip { border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px; font: 0.78rem var(--mono); color: var(--muted); }
	.raw { border-top: 1px solid var(--border); padding-top: 0.8rem; }
	.raw summary { cursor: pointer; color: var(--muted); }
	.raw pre { overflow-x: auto; padding: 0.8rem; background: var(--panel); border: 1px solid var(--border); border-radius: 6px; }
</style>
