/** One registry keyed by fence language. Adding a diagram type is one entry. */
export interface DiagramType {
	id: string;
	label: string;
	langs: string[];
	runtime: 'client' | 'kroki';
	/** Kroki endpoint name when runtime is "kroki" */
	kroki?: string;
}

export const DIAGRAMS: DiagramType[] = [
	{ id: 'mermaid', label: 'Mermaid', langs: ['mermaid'], runtime: 'client' },
	{ id: 'vega-lite', label: 'Vega-Lite', langs: ['vega-lite', 'vegalite'], runtime: 'client' },
	{ id: 'katex', label: 'KaTeX', langs: ['math', 'katex', 'latex'], runtime: 'client' },
	{ id: 'plantuml', label: 'PlantUML', langs: ['plantuml', 'puml'], runtime: 'kroki', kroki: 'plantuml' },
	{
		id: 'c4plantuml',
		label: 'C4-PlantUML',
		langs: ['c4plantuml', 'c4-plantuml', 'c4'],
		runtime: 'kroki',
		kroki: 'c4plantuml'
	},
	{ id: 'graphviz', label: 'Graphviz', langs: ['graphviz', 'dot'], runtime: 'kroki', kroki: 'graphviz' },
	{ id: 'd2', label: 'D2', langs: ['d2'], runtime: 'kroki', kroki: 'd2' },
	{ id: 'erd', label: 'ERD', langs: ['erd'], runtime: 'kroki', kroki: 'erd' },
	{ id: 'nomnoml', label: 'Nomnoml', langs: ['nomnoml'], runtime: 'kroki', kroki: 'nomnoml' },
	{ id: 'svgbob', label: 'Svgbob', langs: ['svgbob'], runtime: 'kroki', kroki: 'svgbob' },
	{ id: 'ditaa', label: 'Ditaa', langs: ['ditaa'], runtime: 'kroki', kroki: 'ditaa' }
];

const byLang = new Map(DIAGRAMS.flatMap((d) => d.langs.map((l) => [l, d] as const)));

export function diagramForLang(lang: string): DiagramType | undefined {
	return byLang.get(lang.toLowerCase());
}

/** Fenced blocks of SilverBullet-only syntax: rendered as an inert chip, never executed. */
export const INERT_FENCES = new Set(['space-lua', 'space-style', 'space-script', 'query', 'template']);
