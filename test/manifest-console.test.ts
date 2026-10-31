import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeMdwiki } from './helpers';

const open: { stop(): void }[] = [];
afterEach(() => open.splice(0).forEach((f) => f.stop()));

const MANIFEST = `---
manifest: 1
summary: Space rules for tests.
pages:
  required_frontmatter: [Stand]
  forbidden_prefixes: ["Sources:"]
folders:
  Notes:
    owner: "alice"
    layer: working
    description: "Scratch notes"
checks: [links]
---
Prose rules for humans and agents.
`;

async function setup() {
	const r = await makeMdwiki();
	open.push(r.mdwiki);
	return r;
}

describe('manifest as a fixed system page', () => {
	it('keeps MANIFEST out of the tree, recent list and quick switcher, but not out of the file system', async () => {
		const { mdwiki } = await setup();
		await mdwiki.writePage('MANIFEST', MANIFEST);
		const flat = (nodes: ReturnType<typeof mdwiki.tree>): string[] => nodes.flatMap((n) => [n.path, ...flat(n.children)]);
		expect(flat(mdwiki.tree())).not.toContain('MANIFEST');
		expect(mdwiki.recent(20).map((p) => p.path)).not.toContain('MANIFEST');
		expect(mdwiki.titles().map((p) => p.path)).not.toContain('MANIFEST');
		expect(mdwiki.index.get('MANIFEST')?.path).toBe('MANIFEST');
		expect(mdwiki.listPages().map((p) => p.path)).toContain('MANIFEST');
	});

	it('reports status and a read-only view for the console', async () => {
		const { mdwiki } = await setup();
		expect(await mdwiki.manifestStatus()).toEqual({ exists: false, valid: true, active: false, issues: 0 });
		await mdwiki.writePage('MANIFEST', MANIFEST);

		expect(await mdwiki.manifestStatus()).toEqual({ exists: true, valid: true, active: true, issues: 0 });
		const view = await mdwiki.manifestView();
		expect(view.exists).toBe(true);
		if (!view.exists) return;
		expect(view.valid).toBe(true);
		expect(view.stale).toBe(false);
		expect(view.rules?.summary).toBe('Space rules for tests.');
		expect(view.folders).toEqual([{ name: 'Notes', owner: 'alice', description: 'Scratch notes', layer: 'working', pages: 1 }]);
		expect(view.labels.working).toBe('Working');
		expect(view.proseHtml).toContain('Prose rules for humans and agents.');
		expect(view.yaml).toContain('summary: Space rules for tests.');
		expect(view.layers.find((l) => l.layer === 'reading')?.hasOverrides).toBe(false);
	});

	it('keeps the last valid rules active when the file on disk turns invalid', async () => {
		const { mdwiki, dir } = await setup();
		await mdwiki.writePage('MANIFEST', MANIFEST);
		fs.writeFileSync(path.join(dir, 'MANIFEST.md'), '---\nmanifest: 1\n---\n');
		const view = await mdwiki.manifestView();
		expect(view.exists).toBe(true);
		if (!view.exists) return;
		expect(view.valid).toBe(false);
		expect(view.stale).toBe(true);
		expect(view.rules?.summary).toBe('Space rules for tests.');
		expect(view.issues.length).toBeGreaterThan(0);
		expect((await mdwiki.manifestStatus()).valid).toBe(false);
	});

	it('refuses to move or delete MANIFEST', async () => {
		const { mdwiki } = await setup();
		await mdwiki.writePage('MANIFEST', MANIFEST);
		await expect(mdwiki.deletePage('MANIFEST')).rejects.toMatchObject({ status: 409, code: 'manifest_fixed' });
		await expect(mdwiki.movePage('MANIFEST', 'Archive/MANIFEST')).rejects.toMatchObject({ status: 409, code: 'manifest_fixed' });
		await expect(mdwiki.movePage('Notes/Garten', 'MANIFEST')).rejects.toMatchObject({ status: 409, code: 'manifest_fixed' });
		expect(mdwiki.index.get('MANIFEST')).toBeTruthy();
		expect(mdwiki.index.get('Notes/Garten')).toBeTruthy();
	});
});
