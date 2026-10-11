/** One registry keyed by fence language. Adding a diagram type is one entry. */
export interface DiagramType {
	id: string;
	label: string;
	langs: string[];
}

export const DIAGRAMS: DiagramType[] = [
	{ id: 'mermaid', label: 'Mermaid', langs: ['mermaid'] },
	{ id: 'vega-lite', label: 'Vega-Lite', langs: ['vega-lite', 'vegalite'] },
	{ id: 'katex', label: 'KaTeX', langs: ['math', 'katex', 'latex'] }
];

const byLang = new Map(DIAGRAMS.flatMap((d) => d.langs.map((l) => [l, d] as const)));

export function diagramForLang(lang: string): DiagramType | undefined {
	return byLang.get(lang.toLowerCase());
}

/** Fenced blocks of SilverBullet-only syntax: rendered as an inert chip, never executed. */
export const INERT_FENCES = new Set(['space-lua', 'space-style', 'space-script', 'query', 'template']);
