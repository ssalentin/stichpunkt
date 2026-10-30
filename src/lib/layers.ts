/**
 * Visibility layers. A page belongs to exactly one layer, derived from its top-level
 * folder in the manifest. Layers are a reading aid, not access control: every reader may
 * open every page, the switch only decides what is listed and searched.
 */
export const LAYERS = ['reading', 'working', 'config'] as const;
export type Layer = (typeof LAYERS)[number];

export const LAYER_VIEWS = ['reading', 'working', 'all'] as const;
export type LayerView = (typeof LAYER_VIEWS)[number];

export const DEFAULT_LAYER_LABELS: Record<Layer, string> = {
	reading: 'Notes',
	working: 'Working',
	config: 'Config'
};

/** Which layers the sidebar view shows. Reading includes config pages. */
export function layersInView(view: LayerView): Layer[] {
	if (view === 'working') return ['working'];
	if (view === 'all') return [...LAYERS];
	return ['reading', 'config'];
}

export function layerInView(layer: Layer | string, view: LayerView): boolean {
	return (layersInView(view) as string[]).includes(layer);
}
