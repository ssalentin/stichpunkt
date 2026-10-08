/**
 * Lazy client-side renderers, keyed by diagram id (see $lib/diagrams.ts).
 * Each loader imports its library on first use only, and `preload` starts the
 * fetch early so the diagram appears without showing its source first.
 */
type Renderer = (el: HTMLElement, source: string) => Promise<void>;

const dark = () => !window.matchMedia('(prefers-color-scheme: light)').matches;

let mermaidCounter = 0;
const renderers: Record<string, Renderer> = {
	async mermaid(el, source) {
		const { default: mermaid } = await import('mermaid');
		mermaid.initialize({
			startOnLoad: false,
			securityLevel: 'strict',
			// diagrams sit on a dark panel in both themes, so the dark theme is the default;
			// `%%{init}%%` directives in the source override it
			theme: 'dark',
			fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
		});
		const id = `mmd-${++mermaidCounter}`;
		try {
			const { svg } = await mermaid.render(id, source);
			el.innerHTML = svg;
		} finally {
			document.getElementById(`d${id}`)?.remove(); // mermaid leaves error scaffolding behind
		}
	},
	async 'vega-lite'(el, source) {
		const [{ default: embed }] = await Promise.all([import('vega-embed')]);
		const spec = JSON.parse(source);
		el.textContent = '';
		await embed(el, spec, {
			mode: 'vega-lite',
			actions: false,
			theme: dark() ? 'dark' : undefined,
			renderer: 'svg'
		});
	},
	async katex(el, source) {
		const [{ default: katex }] = await Promise.all([import('katex'), import('katex/dist/katex.min.css')]);
		katex.render(source, el, {
			displayMode: el.classList.contains('display'),
			throwOnError: true,
			output: 'htmlAndMathml'
		});
	}
};

const preloaders: Record<string, () => Promise<unknown>> = {
	mermaid: () => import('mermaid'),
	'vega-lite': () => import('vega-embed'),
	katex: () => import('katex')
};

/** Starts fetching the libraries for the diagram kinds on this page, before they render. */
export function preload(kinds: Iterable<string>): void {
	for (const kind of kinds) void preloaders[kind]?.().catch(() => {});
}

function showError(el: HTMLElement, label: string, message: string, source: string) {
	el.classList.add('diagram-failed');
	el.textContent = '';
	const box = document.createElement('div');
	box.className = 'diagram-error';
	box.setAttribute('role', 'alert');
	const strong = document.createElement('strong');
	strong.textContent = `${label}: ${message.split('\n')[0].slice(0, 400)}`;
	const pre = document.createElement('pre');
	const code = document.createElement('code');
	code.textContent = source;
	pre.append(code);
	box.append(strong, pre);
	el.append(box);
}

/** Renders every not yet processed client-side diagram below `root`. */
export async function enhance(root: HTMLElement): Promise<void> {
	const nodes = root.querySelectorAll<HTMLElement>('[data-diagram]:not([data-done])');
	await Promise.all(
		[...nodes].map(async (el) => {
			const id = el.dataset.diagram!;
			const render = renderers[id];
			if (!render) return; // server-rendered (Kroki) figures are not touched
			el.dataset.done = '1';
			const source = (el.querySelector('.diagram-src') ?? el).textContent ?? '';
			try {
				await render(el, source);
				el.classList.add('diagram-ready');
			} catch (e) {
				showError(el, id, e instanceof Error ? e.message : String(e), source);
			}
		})
	);
}
