import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRAND, BRAND_COLORS, BRAND_TAGLINE } from '../src/lib/brand';

const root = path.resolve(__dirname, '..');

describe('brand (stichpunkt)', () => {
	it('uses the display name and tagline from one module', () => {
		expect(BRAND).toBe('stichpunkt');
		expect(BRAND_TAGLINE).toBe('Notes that stay in order.');
	});

	it('keeps the tagline English and free of the brand word', () => {
		// Sebastian: the tagline must be English and must not repeat "point"/"stich"
		expect(BRAND_TAGLINE).not.toMatch(/punkt|point|stich/i);
		expect(BRAND_TAGLINE).toMatch(/^[\x20-\x7E]+$/); // ASCII/English only
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

	it('is installable: manifest has id/start_url/scope/standalone and the offline page ships', () => {
		const manifest = fs.readFileSync(path.join(root, 'src/routes/manifest.webmanifest/+server.ts'), 'utf8');
		for (const key of ["id: '/'", 'start_url:', "scope: '/'", "display: 'standalone'", 'shortcuts:']) expect(manifest).toContain(key);
		expect(fs.existsSync(path.join(root, 'static/offline.html'))).toBe(true);
		for (const file of ['narrow.png', 'wide.png']) {
			expect(fs.existsSync(path.join(root, 'static/screenshots', file)), `${file} missing`).toBe(true);
			expect(manifest).toContain(`/screenshots/${file}`);
		}
		expect(fs.readFileSync(path.join(root, 'src/service-worker.ts'), 'utf8')).toContain('/offline.html');
	});

	it('hides the column toggles where their column does not exist (specificity must beat `.top .icon`)', () => {
		const css = fs.readFileSync(path.join(root, 'src/app.css'), 'utf8');
		expect(css).toContain('.top .icon.col-toggle { display: none; }');
		expect(css).toContain('.top .icon.col-toggle:not(.right-toggle) { display: inline-flex; }');
		expect(css).toContain('.top .icon.right-toggle { display: inline-flex; }');
	});
});
