import { escapeHtml, type Widget } from './markdown';
import { runPagesQuery, type PagesQuery } from './pages-query';
import type { SpaceIndex } from './space';

const e = escapeHtml;
const href = (path: string) => '/' + encodeURI(path);
const link = (path: string, label = path) => `<a class="wikilink" href="${href(path)}">${e(label)}</a>`;

/**
 * The query a preset maps to. `kb.recent` is a plain `pages` query; the section header needs
 * the same filtered set for its count, so it asks the engine too.
 */
export function widgetQuery(w: Widget): PagesQuery {
	switch (w.kind) {
		case 'recent':
			return { tag: w.tag, sort: 'date desc', limit: w.limit, show: 'list' };
		case 'section':
			return { tag: w.tag, show: 'count' };
	}
	return { show: 'count' };
}

const dateOf = (p: { frontmatter: Record<string, unknown> }) =>
	p.frontmatter.date == null ? '' : String(p.frontmatter.date);

/**
 * Native replacements for the four SilverBullet helpers the knowledge base uses. They are thin
 * presets over {@link runPagesQuery}: the same engine as the `pages` block, one code path.
 * Everything is escaped HTML built from index data.
 */
export function renderWidget(w: Widget, index: SpaceIndex, self: string): string {
	const cats = index.categories();
	switch (w.kind) {
		case 'section': {
			const cat = cats.find((c) => c.tag === w.tag);
			if (!cat) return `<div class="wg"><span class="wg-warn">Unknown category: ${e(w.tag)}</span></div>`;
			// the engine counts the notes and the newest date comes from the same candidate set
			const notes = index.noteTagged(cat.tag);
			const count = runPagesQuery(index, widgetQuery(w), self, { candidates: notes }).total;
			const last = notes
				.map(dateOf)
				.filter(Boolean)
				.sort()
				.at(-1);
			return (
				`<div class="wg wg-section hue-${cat.hue}"><span class="wg-badge" aria-hidden="true">${e([...cat.label][0]?.toUpperCase() ?? '?')}</span>` +
				`<span class="wg-label">${e(cat.label)}</span>` +
				`<span class="wg-meta">${count} ${count === 1 ? 'note' : 'notes'}${last ? ` · last ${e(last)}` : ''}</span>` +
				`<span class="wg-home">${link('index', 'Start')}</span></div>`
			);
		}
		case 'recent': {
			const result = runPagesQuery(index, widgetQuery(w), self, { candidates: index.noteTagged(w.tag), exclude: self });
			if (!result.total) return `<div class="wg wg-list"><p class="muted">No note in this category yet.</p></div>`;
			const hue = cats.find((c) => c.tag === w.tag)?.hue ?? 0;
			return (
				`<div class="wg wg-list hue-${hue}"><ul>` +
				result.rows.map((row) => `<li>${link(row.path)}<span class="wg-date">${e(row.date)}</span></li>`).join('') +
				'</ul></div>'
			);
		}
		case 'header': {
			const seen = new Set<string>();
			for (const c of cats) for (const p of index.noteTagged(c.tag)) seen.add(p.path);
			return `<div class="wg wg-status"><strong>${seen.size}</strong> ${seen.size === 1 ? 'note' : 'notes'} in <strong>${cats.length}</strong> ${cats.length === 1 ? 'category' : 'categories'}</div>`;
		}
		case 'categories':
			return (
				'<div class="wg-cards">' +
				cats
					.map(
						(c) =>
							`<a class="wg wg-card hue-${c.hue}" href="${href(c.page)}"><span class="wg-badge" aria-hidden="true">${e([...c.label][0]?.toUpperCase() ?? '?')}</span>` +
							`<span class="wg-label">${e(c.label)}</span><span class="wg-meta">${c.count}</span></a>`
					)
					.join('') +
				'</div>'
			);
	}
}
