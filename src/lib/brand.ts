/**
 * The one place that knows the display name and brand copy.
 * UI titles, the MCP server name and the manifest all use it, so the final
 * rename or a new tagline is a single change.
 */
export const BRAND = 'stichpunkt';
export const BRAND_TAGLINE = 'Notes that stay in order.';
export const BRAND_REPO = 'https://github.com/ssalentin/stichpunkt';
export const BRAND_DESCRIPTION = 'A fast, minimal markdown wiki over plain files.';

/** Brand palette (dark is the default theme; see IS-172). */
export const BRAND_COLORS = {
	dark: { bg: '#0E1116', ink: '#E6EDF3', accent: '#F5B544', stitch: '#8B96A3' },
	light: { bg: '#F6F3EC', ink: '#14181F', accent: '#A84F00', stitch: '#5B6672' }
} as const;
