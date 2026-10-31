/**
 * Gate for the in-app manifest editor. The endpoint exists in the build either way; this decides
 * whether this instance offers it. Default is off, so a deploy alone never opens a write path —
 * someone has to enable it on purpose (`MANIFEST_UI_WRITE=1`), and can close it again without a
 * new build.
 */

export function manifestWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.MANIFEST_UI_WRITE === '1';
}

/**
 * Reasons a request may not use the editor, or `null` when it may. Machine traffic (the token
 * router stamps `X-Mdwiki-Zone`) is never a person at a browser, so it never edits rules.
 */
export function manifestWriteRefusal(
	headers: { has(name: string): boolean },
	env: NodeJS.ProcessEnv = process.env,
	machineZoneHeader = 'x-mdwiki-zone'
): string | null {
	if (!manifestWriteEnabled(env)) return 'Editing the manifest is disabled on this instance.';
	if (headers.has(machineZoneHeader)) return 'The manifest editor is for people in the browser, not for machine requests.';
	return null;
}
