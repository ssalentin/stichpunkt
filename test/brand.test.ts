import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRAND, BRAND_COLORS, BRAND_TAGLINE } from '../src/lib/brand';

const root = path.resolve(__dirname, '..');

describe('brand (stichpunkt)', () => {
	it('uses the display name and tagline from one module', () => {
		expect(BRAND).toBe('stichpunkt');
		expect(BRAND_TAGLINE).toBe('Punkt für Punkt.');
	});

	it('keeps the dark palette from the design', () => {
		expect(BRAND_COLORS.dark).toEqual({ bg: '#0E1116', ink: '#E6EDF3', accent: '#F5B544', stitch: '#8B96A3' });
	});

	it('ships the PWA icons referenced by the manifest', () => {
		const manifest = fs.readFileSync(path.join(root, 'src/routes/manifest.webmanifest/+server.ts'), 'utf8');
		for (const file of ['icon-192.png', 'icon-512.png', 'icon-maskable-192.png', 'icon-maskable-512.png']) {
			expect(fs.existsSync(path.join(root, 'static', file)), `${file} missing`).toBe(true);
			expect(manifest).toContain(`/${file}`);
		}
		expect(manifest).toContain('BRAND_COLORS.dark.bg');
	});
});
