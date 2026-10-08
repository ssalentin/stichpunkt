import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildMcpServer } from '#lib/server/mcp';
import { getFolio } from '#lib/server/service';
import type { RequestHandler } from './$types';

const notAllowed = () =>
	new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server)' }, id: null }), {
		status: 405,
		headers: { 'content-type': 'application/json', allow: 'POST' }
	});

/** Stateless Streamable HTTP: a fresh server + transport per request, JSON responses. */
export const POST: RequestHandler = async ({ request }) => {
	const folio = await getFolio();
	const server = buildMcpServer(folio);
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true
	});
	await server.connect(transport);
	try {
		return await transport.handleRequest(request);
	} finally {
		// the response body is already materialised in JSON mode
		queueMicrotask(() => void server.close());
	}
};

export const GET: RequestHandler = async () => notAllowed();
export const DELETE: RequestHandler = async () => notAllowed();
