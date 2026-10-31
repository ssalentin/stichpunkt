import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { manifestWriteEnabled, manifestWriteRefusal } from '../src/lib/server/manifest-write';
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

describe('editing the manifest from the console', () => {
	it('hands the raw file to the editor', async () => {
		const { mdwiki } = await setup();
		await mdwiki.writePage('MANIFEST', MANIFEST);
		const view = await mdwiki.manifestView();
		if (!view.exists) throw new Error('manifest missing');
		expect(view.raw).toBe(MANIFEST);
	});

	it('writes in place against the version that was opened', async () => {
		const { mdwiki } = await setup();
		const first = await mdwiki.writePage('MANIFEST', MANIFEST);
		const view = await mdwiki.manifestView();
		if (!view.exists) throw new Error('manifest missing');
		const edited = MANIFEST.replace('Space rules for tests.', 'Space rules, second take.');
		const res = await mdwiki.writePage('MANIFEST', edited, view.hash, 'web-ui', 'manifest console');
		expect(res.hash).not.toBe(first.hash);
		expect((await mdwiki.manifestView()).exists && (await mdwiki.manifestView()).rules?.summary).toBe('Space rules, second take.');
		// the old version is a conflict, not an overwrite
		await expect(mdwiki.writePage('MANIFEST', MANIFEST, first.hash, 'web-ui')).rejects.toMatchObject({ status: 409 });
	});

	it('rejects an invalid edit before it reaches the disk', async () => {
		const { mdwiki, dir } = await setup();
		await mdwiki.writePage('MANIFEST', MANIFEST);
		const view = await mdwiki.manifestView();
		if (!view.exists) throw new Error('manifest missing');
		await expect(mdwiki.writePage('MANIFEST', '---\nmanifest: 1\n---\n', view.hash, 'web-ui')).rejects.toMatchObject({
			status: 400,
			code: 'manifest_invalid'
		});
		expect(fs.readFileSync(path.join(dir, 'MANIFEST.md'), 'utf8')).toBe(MANIFEST);
	});

	it('keeps the editor reachable while the file on disk is invalid', async () => {
		const { mdwiki, dir } = await setup();
		await mdwiki.writePage('MANIFEST', MANIFEST);
		fs.writeFileSync(path.join(dir, 'MANIFEST.md'), '---\nmanifest: 1\nStand: 2026-01-01\n---\n');
		const view = await mdwiki.manifestView();
		if (!view.exists) throw new Error('manifest missing');
		expect(view.valid).toBe(false);
		// the raw text is what the editor has to offer for fixing it
		expect(view.raw).toContain('Stand: 2026-01-01');
		// and the last valid rules stay visible
		expect(view.rules?.summary).toBe('Space rules for tests.');
	});
});

describe('the gate in front of the editor', () => {
	const headers = (names: string[] = []) => ({ has: (name: string) => names.includes(name) });

	it('is off unless the instance enables it', () => {
		expect(manifestWriteEnabled({})).toBe(false);
		expect(manifestWriteEnabled({ MANIFEST_UI_WRITE: 'true' })).toBe(false);
		expect(manifestWriteEnabled({ MANIFEST_UI_WRITE: '1' })).toBe(true);
		expect(manifestWriteRefusal(headers(), {})).toMatch(/disabled/);
	});

	it('refuses machine requests even when it is on', () => {
		expect(manifestWriteRefusal(headers(['x-mdwiki-zone']), { MANIFEST_UI_WRITE: '1' })).toMatch(/machine/);
		expect(manifestWriteRefusal(headers(), { MANIFEST_UI_WRITE: '1' })).toBeNull();
	});
});
