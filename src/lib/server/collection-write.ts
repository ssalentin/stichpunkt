/**
 * Gate for editing collection rows in the browser. The endpoints exist in the build either way;
 * this decides whether an instance offers them. Default off (`COLLECTIONS_UI_WRITE=1` enables),
 * and machine traffic is refused, exactly like the manifest editor.
 */

export function collectionWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.COLLECTIONS_UI_WRITE === '1';
}

export function collectionWriteRefusal(
	headers: { has(name: string): boolean },
	env: NodeJS.ProcessEnv = process.env,
	machineZoneHeader = 'x-mdwiki-zone'
): string | null {
	if (!collectionWriteEnabled(env)) return 'Editing rows is disabled on this instance.';
	if (headers.has(machineZoneHeader)) return 'Row editing is for people in the browser, not for machine requests.';
	return null;
}
