import { json } from '@sveltejs/kit';
import { BRAND, BRAND_DESCRIPTION } from '#lib/brand';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () =>
	json(
		{
			name: BRAND,
			short_name: BRAND,
			description: BRAND_DESCRIPTION,
			start_url: '/',
			scope: '/',
			display: 'standalone',
			background_color: '#0b0f14',
			theme_color: '#0b0f14',
			icons: [
				{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
				{ src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
				{ src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
			]
		},
		{ headers: { 'content-type': 'application/manifest+json', 'cache-control': 'public, max-age=3600' } }
	);
