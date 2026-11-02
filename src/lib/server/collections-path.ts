/** Local default, deliberately outside the space: see the note at the top of collections.ts. */
export const COLLECTIONS_DB_DEFAULT = '/var/lib/stichpunkt/collections.sqlite';

export function collectionsFile(_spaceDir: string, env: NodeJS.ProcessEnv = process.env): string {
	return env.COLLECTIONS_DB || COLLECTIONS_DB_DEFAULT;
}
