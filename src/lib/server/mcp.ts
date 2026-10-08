import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { FolioError } from './errors';
import type { Folio } from './service';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (value: unknown): ToolResult => ({
	content: [{ type: 'text', text: JSON.stringify(value, null, 2) }]
});

async function run(fn: () => unknown | Promise<unknown>): Promise<ToolResult> {
	try {
		return ok(await fn());
	} catch (e) {
		if (e instanceof FolioError) {
			return {
				isError: true,
				content: [
					{
						type: 'text',
						text: JSON.stringify({ error: e.code, status: e.status, message: e.message, ...e.details }, null, 2)
					}
				]
			};
		}
		console.error('[folio] mcp tool failed:', e);
		return { isError: true, content: [{ type: 'text', text: '{"error":"internal"}' }] };
	}
}

/** Same service layer as REST; one server instance per request (stateless). */
export function buildMcpServer(folio: Folio): McpServer {
	const server = new McpServer({ name: 'folio', version: '0.1.0' });
	const path = z.string().describe('Page name without ".md", e.g. "Server/SilverBullet"');

	server.registerTool(
		'search',
		{ description: 'Full-text search over titles and content', inputSchema: { query: z.string(), limit: z.number().int().optional() } },
		({ query, limit }) => run(() => folio.search(query, limit ?? 30))
	);
	server.registerTool(
		'list_pages',
		{ description: 'List pages, optionally below a path prefix', inputSchema: { prefix: z.string().optional() } },
		({ prefix }) => run(() => folio.listPages(prefix ?? ''))
	);
	server.registerTool(
		'read_page',
		{ description: 'Read a page: content, frontmatter and content hash (use the hash as base_hash)', inputSchema: { path } },
		({ path }) => run(() => folio.readPage(path))
	);
	server.registerTool(
		'write_page',
		{
			description:
				'Create or overwrite a page. With base_hash the write fails with a conflict if the page changed meanwhile; use "" to require that the page does not exist yet.',
			inputSchema: { path, content: z.string(), base_hash: z.string().optional() }
		},
		({ path, content, base_hash }) => run(() => folio.writePage(path, content, base_hash))
	);
	server.registerTool(
		'append_to_page',
		{ description: 'Append text to a page (creates it when missing)', inputSchema: { path, content: z.string() } },
		({ path, content }) => run(() => folio.appendToPage(path, content))
	);
	server.registerTool(
		'delete_page',
		{ description: 'Delete a page', inputSchema: { path } },
		({ path }) => run(() => folio.deletePage(path))
	);
	server.registerTool('list_tags', { description: 'All tags with page counts', inputSchema: {} }, () =>
		run(() => folio.listTags())
	);
	server.registerTool(
		'pages_by_tag',
		{ description: 'Pages carrying a tag', inputSchema: { tag: z.string() } },
		({ tag }) => run(() => folio.pagesByTag(tag))
	);
	server.registerTool(
		'get_backlinks',
		{ description: 'Pages linking to a page', inputSchema: { path } },
		({ path }) => run(() => folio.getBacklinks(path))
	);
	server.registerTool(
		'upload_attachment',
		{
			description:
				'Store a file (png, jpg, gif, webp, svg, pdf, txt, csv, json, md, ...) at a path inside the space, e.g. "Urlaub/_attachments/map.png"',
			inputSchema: { path: z.string(), content_base64: z.string() }
		},
		({ path, content_base64 }) =>
			run(() => {
				if (!/^[A-Za-z0-9+/]*={0,2}$/.test(content_base64.replace(/\s+/g, ''))) {
					throw new FolioError(400, 'bad_content', '"content_base64" is not valid base64');
				}
				return folio.uploadAttachment(path, Buffer.from(content_base64, 'base64'));
			})
	);
	return server;
}
