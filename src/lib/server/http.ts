import { json } from '@sveltejs/kit';
import { FolioError } from './errors';

/** Maps service errors to JSON responses; anything unexpected becomes a 500 without details. */
export function fail(e: unknown): Response {
	if (e instanceof FolioError) {
		return json({ error: e.code, message: e.message, ...e.details }, { status: e.status });
	}
	console.error('[folio] unexpected error:', e);
	return json({ error: 'internal', message: 'Internal error' }, { status: 500 });
}

export async function readJson(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
	const len = Number(request.headers.get('content-length') ?? 0);
	if (len > maxBytes) throw new FolioError(413, 'too_large', 'Request body too large');
	const text = await request.text();
	if (Buffer.byteLength(text) > maxBytes) throw new FolioError(413, 'too_large', 'Request body too large');
	try {
		const v = JSON.parse(text);
		if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
	} catch {
		/* fall through */
	}
	throw new FolioError(400, 'bad_json', 'Body must be a JSON object');
}

export async function readBytes(request: Request, maxBytes: number): Promise<Buffer> {
	const len = Number(request.headers.get('content-length') ?? 0);
	if (len > maxBytes) throw new FolioError(413, 'too_large', 'Request body too large');
	const buf = Buffer.from(await request.arrayBuffer());
	if (buf.length > maxBytes) throw new FolioError(413, 'too_large', 'Request body too large');
	return buf;
}
