import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { diagramForLang } from '../src/lib/diagrams';

const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'src/app.css'), 'utf8');
const service = fs.readFileSync(path.join(root, 'src/lib/server/service.ts'), 'utf8');

describe('diagram placeholder contract', () => {
	it('marks server-rendered Kroki figures with diagram-svg', () => {
		// the CSS relies on this class to skip the "loading" placeholder
		expect(service).toContain('class="diagram diagram-svg"');
	});

	it('never draws the client-side placeholder on a server-rendered figure', () => {
		// every shimmer/placeholder selector must exclude .diagram-svg, otherwise the
		// Kroki figures keep the dark bar forever (they are never marked diagram-ready)
		const selectors = css.match(/\.diagram\[data-diagram\][^{]*\{/g) ?? [];
		expect(selectors.length).toBeGreaterThan(0);
		for (const sel of selectors) {
			if (sel.includes('diagram-ready')) expect(sel, sel).toContain(':not(.diagram-svg)');
		}
	});

	it('keeps the diagram registry consistent', () => {
		expect(diagramForLang('mermaid')?.id).toBe('mermaid');
		expect(diagramForLang('plantuml')?.runtime).toBe('kroki');
		expect(diagramForLang('d2')?.kroki).toBe('d2');
	});
});
