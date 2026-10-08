/** CodeMirror 6 setup. Imported lazily by Editor.svelte, never part of the initial bundle. */
import { autocompletion, type CompletionContext, startCompletion } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentLess, indentMore, undo as cmUndo } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { drawSelection, EditorView, keymap } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

interface Hooks {
	onChange(): void;
	onFocus(focused: boolean): void;
	onSave(): void;
	onExit(): void;
}

let titles: Promise<string[]> | undefined;
let tagNames: Promise<string[]> | undefined;
const loadTitles = () => (titles ??= fetch('/_ui/titles').then((r) => r.json()).then((l: { path: string }[]) => l.map((x) => x.path)));
const loadTags = () => (tagNames ??= fetch('/_ui/tags').then((r) => r.json()).then((l: { name: string }[]) => l.map((x) => x.name)));

async function pageSource(ctx: CompletionContext) {
	const m = ctx.matchBefore(/\[\[[^\]\n|#]*/);
	if (!m) return null;
	const options = (await loadTitles()).map((p) => ({
		label: p,
		apply: (view: EditorView, _c: unknown, from: number, to: number) => {
			const hasClose = view.state.sliceDoc(to, to + 2) === ']]';
			view.dispatch({ changes: { from, to, insert: p + (hasClose ? '' : ']]') }, selection: { anchor: from + p.length + 2 } });
		}
	}));
	return { from: m.from + 2, options, validFor: /^[^\]\n|#]*$/ };
}

async function tagSource(ctx: CompletionContext) {
	const m = ctx.matchBefore(/#[\p{L}\p{N}_\-/]*/u);
	if (!m) return null;
	const prev = m.from > 0 ? ctx.state.sliceDoc(m.from - 1, m.from) : ' ';
	if (!/\s/.test(prev)) return null;
	// not a heading marker
	if (m.text === '#' && !ctx.explicit && ctx.state.doc.lineAt(m.from).from === m.from) return null;
	return {
		from: m.from + 1,
		options: (await loadTags()).map((n) => ({ label: n, type: 'keyword' })),
		validFor: /^[\p{L}\p{N}_\-/]*$/u
	};
}

const highlight = HighlightStyle.define([
	{ tag: t.heading, color: 'var(--accent)', fontWeight: '700' },
	{ tag: [t.link, t.url], color: 'var(--link)' },
	{ tag: t.emphasis, fontStyle: 'italic' },
	{ tag: t.strong, fontWeight: '700' },
	{ tag: t.monospace, color: 'var(--code)' },
	{ tag: [t.processingInstruction, t.meta, t.quote], color: 'var(--muted)' }
]);

export async function create(parent: HTMLElement, doc: string, hooks: Hooks): Promise<EditorView> {
	return new EditorView({
		parent,
		state: EditorState.create({
			doc,
			extensions: [
				history(),
				drawSelection(),
				EditorView.lineWrapping,
				markdown(),
				syntaxHighlighting(highlight),
				autocompletion({ override: [pageSource, tagSource], activateOnTyping: true }),
				keymap.of([
					{ key: 'Mod-s', run: () => (hooks.onSave(), true), preventDefault: true },
					{ key: 'Escape', run: () => (hooks.onExit(), true) },
					{ key: 'Tab', run: indentMore, shift: indentLess },
					...defaultKeymap,
					...historyKeymap
				]),
				EditorView.contentAttributes.of({ autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' }),
				EditorView.updateListener.of((u) => {
					if (u.docChanged) hooks.onChange();
					if (u.focusChanged) hooks.onFocus(u.view.hasFocus);
				}),
				EditorView.theme({
					'&': { color: 'var(--fg)', backgroundColor: 'var(--panel)', fontSize: '16px', minHeight: '60vh' },
					'.cm-content': { fontFamily: 'var(--mono)', caretColor: 'var(--accent)', padding: '0.75rem 0.5rem' },
					'.cm-cursor': { borderLeftColor: 'var(--accent)' },
					'&.cm-focused': { outline: 'none' },
					'.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--sel)' },
					'.cm-tooltip': { backgroundColor: 'var(--panel)', border: '1px solid var(--border)', color: 'var(--fg)' },
					'.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--sel)', color: 'var(--fg)' }
				})
			]
		})
	});
}

export function insert(view: EditorView, text: string) {
	const { from, to } = view.state.selection.main;
	view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
	view.focus();
}

export function wikilink(view: EditorView) {
	const { from, to } = view.state.selection.main;
	const sel = view.state.sliceDoc(from, to);
	view.dispatch({ changes: { from, to, insert: `[[${sel}]]` }, selection: { anchor: from + 2 + sel.length } });
	view.focus();
	if (!sel) startCompletion(view);
}

function toggleLinePrefix(view: EditorView, re: RegExp, prefix: string) {
	const line = view.state.doc.lineAt(view.state.selection.main.head);
	const m = re.exec(line.text);
	view.dispatch({ changes: m ? { from: line.from, to: line.from + m[0].length, insert: '' } : { from: line.from, insert: prefix } });
	view.focus();
}

export const task = (v: EditorView) => toggleLinePrefix(v, /^(\s*)- \[[ x]\] /, '- [ ] ');
export const list = (v: EditorView) => toggleLinePrefix(v, /^\s*- /, '- ');

export function heading(view: EditorView) {
	const line = view.state.doc.lineAt(view.state.selection.main.head);
	const m = /^(#{1,5}) /.exec(line.text);
	if (!m) view.dispatch({ changes: { from: line.from, insert: '## ' } });
	else if (m[1].length < 5) view.dispatch({ changes: { from: line.from, insert: '#' } });
	else view.dispatch({ changes: { from: line.from, to: line.from + 6, insert: '' } });
	view.focus();
}

export function indent(view: EditorView, dir: 1 | -1) {
	(dir > 0 ? indentMore : indentLess)(view);
	view.focus();
}

export function undo(view: EditorView) {
	cmUndo(view);
	view.focus();
}
