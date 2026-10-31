import { describe, expect, it } from 'vitest';
import { collectionWriteEnabled, collectionWriteRefusal } from '../src/lib/server/collection-write';

const headers = (names: string[] = []) => ({ has: (name: string) => names.includes(name.toLowerCase()) });

describe('collection write gate', () => {
	it('is off by default and only opens with the explicit flag', () => {
		expect(collectionWriteEnabled({} as NodeJS.ProcessEnv)).toBe(false);
		expect(collectionWriteEnabled({ COLLECTIONS_UI_WRITE: 'true' } as NodeJS.ProcessEnv)).toBe(false);
		expect(collectionWriteEnabled({ COLLECTIONS_UI_WRITE: '1' } as NodeJS.ProcessEnv)).toBe(true);
	});

	it('refuses machine traffic even when the flag is on', () => {
		const env = { COLLECTIONS_UI_WRITE: '1' } as NodeJS.ProcessEnv;
		expect(collectionWriteRefusal(headers(), env)).toBeNull();
		expect(collectionWriteRefusal(headers(['x-mdwiki-zone']), env)).toMatch(/machine/i);
	});

	it('reports the disabled state before anything else', () => {
		expect(collectionWriteRefusal(headers(), {} as NodeJS.ProcessEnv)).toMatch(/disabled/i);
		expect(collectionWriteRefusal(headers(['x-mdwiki-zone']), {} as NodeJS.ProcessEnv)).toMatch(/disabled/i);
	});
});
