import { escapeHtml, type Widget } from './markdown';
import type { PageRec, SpaceIndex } from './space';

const e = escapeHtml;
const href = (path: string) => '/' + encodeURI(path);
const link = (path: string, label = path) => `<a class="wikilink" href="${href(path)}">${e(label)}</a>`;
const dateOf = (p: PageRec) => (p.frontmatter.date == null ? '' : String(p.frontmatter.date));

/** Newest first by frontmatter date (string compare), then by path. */
function newest(pages: PageRec[]): PageRec[] {
	return [...pages].sort((a, b) => dateOf(b).localeCompare(dateOf(a)) || a.path.localeCompare(b.path));
}

/**
 * Native replacements for the four SilverBullet helpers the knowledge base uses. Plain escaped HTML
 * built from index data; nothing from page content is passed through as markup.
 */
export function renderWidget(w: Widget, index: SpaceIndex, self: string): string {
	const cats = index.categories();
	switch (w.kind) {
		case 'section': {
			const cat = cats.find((c) => c.tag === w.tag);
			if (!cat) return `<div class="wg"><span class="wg-warn">Unknown category: ${e(w.tag)}</span></div>`;
			const notes = index.noteTagged(cat.tag);
			const last = newest(notes).map(dateOf).find(Boolean);
			return (
				`<div class="wg wg-section hue-${cat.hue}"><span class="wg-badge" aria-hidden="true">${e([...cat.label][0]?.toUpperCase() ?? '?')}</span>` +
				`<span class="wg-label">${e(cat.label)}</span>` +
				`<span class="wg-meta">${notes.length} ${notes.length === 1 ? 'note' : 'notes'}${last ? ` · last ${e(last)}` : ''}</span>` +
				`<span class="wg-home">${link('index', 'Start')}</span></div>`
			);
		}
		case 'recent': {
			const pages = newest(index.noteTagged(w.tag).filter((p) => p.path !== self)).slice(0, w.limit);
			if (!pages.length) return `<div class="wg wg-list"><p class="muted">No note in this category yet.</p></div>`;
			const hue = cats.find((c) => c.tag === w.tag)?.hue ?? 0;
			return (
				`<div class="wg wg-list hue-${hue}"><ul>` +
				pages.map((p) => `<li>${link(p.path)}<span class="wg-date">${e(dateOf(p))}</span></li>`).join('') +
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
