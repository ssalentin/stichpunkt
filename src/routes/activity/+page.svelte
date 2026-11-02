<script lang="ts">
	import { BRAND } from '#lib/brand';
	import { groupByDay, type FeedEntry } from '#lib/activity-feed';

	let { data } = $props();

	const ZONE = 'Europe/Berlin';
	const time = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', minute: '2-digit' });
	const day = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

	const groups = $derived(groupByDay(data.items, ZONE));

	const verbs: Record<string, string> = {
		write_page: 'edited',
		append_to_page: 'appended to',
		move_page: 'moved',
		delete_page: 'deleted',
		create: 'created a row in',
		update: 'updated a row in',
		delete: 'deleted a row in'
	};

	const sources: Record<FeedEntry['actorSource'], { label: string; title: string }> = {
		token: { label: 'verified', title: 'Actor came from an authenticated token.' },
		field: { label: 'self-declared', title: 'Actor came from the request body or X-Agent header; not verified.' },
		human: { label: 'app', title: 'Change was made in the web interface.' },
		system: { label: 'system', title: 'Automated writer: migration, deploy gate or raw API.' },
		unknown: { label: 'unknown', title: 'The writer sent no actor.' }
	};

	function verb(action: string): string {
		return verbs[action] ?? action.replaceAll('_', ' ');
	}

	function dayLabel(value: string): string {
		const parsed = new Date(`${value}T12:00:00Z`);
		return Number.isNaN(parsed.getTime()) ? 'Unknown day' : day.format(parsed);
	}
</script>

<svelte:head><title>Activity · {BRAND}</title></svelte:head>

<article class="page activity">
	<header class="activity-head">
		<p class="eyebrow">System</p>
		<h1>Activity</h1>
	</header>
	<p class="muted intro">
		Who changed what, newest first. Page revisions come from the write API and MCP, row revisions from the collections database.
		Times are {ZONE}.
	</p>

	<form class="filters" method="get">
		<label class="filter">
			<span>Actor</span>
			<input name="actor" value={data.actor} placeholder="agent slug, e.g. knowledge-steward" autocomplete="off" />
		</label>
		<label class="filter">
			<span>Since</span>
			<input type="date" name="since" value={data.since} />
		</label>
		<div class="filter-actions">
			<button class="btn small primary" type="submit">Apply</button>
			<a class="btn small" href="/activity">Clear</a>
		</div>
	</form>

	{#if data.items.length}
		<p class="muted count" role="status">
			{data.items.length}
			{data.items.length === 1 ? 'change' : 'changes'}{data.items.length >= data.limit ? ` (newest ${data.limit})` : ''}
		</p>
		{#each groups as group (group.day)}
			<section class="day">
				<h2>{dayLabel(group.day)}</h2>
				<ul class="feed">
					{#each group.entries as entry (entry.id)}
						<li class="entry">
							<time class="when" datetime={entry.at}>{time.format(new Date(entry.at))}</time>
							<span class="what">
								<span class="actor" title="actor: {entry.actor}">{entry.actorName}</span>
								<span class="verb">{verb(entry.action)}</span>
								<a class="target" href={entry.href}>{entry.target}</a>
								{#if entry.detail}<span class="detail">— {entry.detail}</span>{/if}
							</span>
							<span class="badge src-{entry.actorSource}" title={sources[entry.actorSource].title}>{sources[entry.actorSource].label}</span>
						</li>
					{/each}
				</ul>
			</section>
		{/each}
	{:else}
		<p class="notice">No recorded changes match this filter.</p>
	{/if}

	<p class="muted foot">
		Direct file edits on the server are not recorded; only writes through Stichpunkt appear here. An actor name without
		<span class="badge src-token">verified</span> is self-declared.
	</p>
</article>

<style>
	.activity { max-width: 82ch; }
	.eyebrow { margin: 0; font: 700 0.72rem var(--mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }
	.activity-head h1 { margin: 0.15rem 0 0.6rem; }
	.intro { margin: 0 0 1.2rem; }
	.filters { display: grid; grid-template-columns: minmax(10rem, 1.4fr) minmax(9rem, 0.8fr) auto; gap: 0.5rem; align-items: end; margin: 0 0 1rem; }
	.filter { display: flex; flex-direction: column; gap: 0.2rem; min-width: 0; }
	.filter > span { color: var(--muted); font: 700 0.7rem var(--mono); letter-spacing: 0.05em; text-transform: uppercase; }
	.filters input { width: 100%; min-height: 34px; padding: 0.3rem 0.5rem; color: var(--fg); background: var(--panel); border: 1px solid var(--border); border-radius: 6px; font: inherit; }
	.filter-actions { display: flex; gap: 0.4rem; }
	.activity :is(a, button, input):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
	.count { margin: 0 0 0.6rem; font: 0.78rem var(--mono); }
	.day { margin: 0 0 1rem; }
	.day h2 { margin: 0 0 0.3rem; font-size: 0.8rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); border-bottom: 1px solid var(--border); padding-bottom: 0.25rem; }
	.feed { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.15rem; }
	.entry { display: grid; grid-template-columns: 3.4rem minmax(0, 1fr) auto; gap: 0.55rem; align-items: baseline; padding: 0.28rem 0.1rem; border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, transparent); }
	.when { color: var(--muted); font: 0.78rem var(--mono); font-variant-numeric: tabular-nums; }
	.what { min-width: 0; overflow-wrap: anywhere; }
	.actor { font-weight: 700; }
	.verb { color: var(--muted); }
	.target { font-family: var(--mono); font-size: 0.9em; text-decoration-line: underline; text-underline-offset: 0.15em; }
	.detail { color: var(--muted); font-size: 0.9em; }
	.badge { white-space: nowrap; border: 1px solid var(--border); border-radius: 999px; padding: 0 6px; font: 0.68rem var(--mono); color: var(--muted); }
	.badge.src-token { border-color: var(--hl-string); color: var(--hl-string); }
	.badge.src-field { border-style: dashed; }
	.badge.src-human { border-color: var(--accent); color: var(--accent); }
	.notice { padding: 0.6rem 0.8rem; border-left: 3px solid var(--accent); background: var(--panel); }
	.foot { margin: 1.2rem 0 0; font-size: 0.82rem; }

	@media (max-width: 639px) {
		.filters { grid-template-columns: minmax(0, 1fr); align-items: stretch; }
		.filter-actions .btn { flex: 1; justify-content: center; }
		.entry { grid-template-columns: 3rem minmax(0, 1fr); }
		.entry .badge { grid-column: 2; justify-self: start; }
	}
</style>
