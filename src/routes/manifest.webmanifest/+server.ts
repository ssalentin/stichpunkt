import { json } from '@sveltejs/kit';
import { BRAND, BRAND_COLORS, BRAND_DESCRIPTION } from '#lib/brand';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () =>
	json(
		{
			name: BRAND,
			short_name: BRAND,
			description: BRAND_DESCRIPTION,
			id: '/',
			start_url: '/?source=pwa',
			scope: '/',
			lang: 'en',
			dir: 'ltr',
			display: 'standalone',
			display_override: ['standalone', 'minimal-ui'],
			orientation: 'any',
			categories: ['productivity', 'utilities'],
			shortcuts: [
				{ name: 'Home', url: '/?source=shortcut', icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }] }
			],
			background_color: BRAND_COLORS.dark.bg,
			theme_color: BRAND_COLORS.dark.bg,
			icons: [
				{ src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
				{ src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
				{ src: '/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
				{ src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
			]
		},
		{ headers: { 'content-type': 'application/manifest+json', 'cache-control': 'public, max-age=3600' } }
	);
