import { describe, expect, it } from 'vitest';
import { diagramForLang } from '../src/lib/diagrams';

describe('diagram registry', () => {
	it('maps client-side types only; server-side languages are plain code', () => {
		expect(diagramForLang('mermaid')?.id).toBe('mermaid');
		expect(diagramForLang('plantuml')).toBeUndefined();
		expect(diagramForLang('d2')).toBeUndefined();
		expect(diagramForLang('dot')).toBeUndefined();
	});
});
