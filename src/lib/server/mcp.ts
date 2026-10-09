import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BRAND } from '../brand';
import { MdwikiError } from './errors';
import type { Mdwiki } from './service';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (value: unknown): ToolResult => ({
	content: [{ type: 'text', text: JSON.stringify(value, null, 2) }]
});

async function run(fn: () => unknown | Promise<unknown>): Promise<ToolResult> {
	try {
		return ok(await fn());
	} catch (e) {
		if (e instanceof MdwikiError) {
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
		console.error('[mdwiki] mcp tool failed:', e);
		return { isError: true, content: [{ type: 'text', text: '{"error":"internal"}' }] };
	}
}

/** Same service layer as REST; one server instance per request (stateless). */
export function buildMcpServer(mdwiki: Mdwiki): McpServer {
	const server = new McpServer({ name: BRAND, version: '0.1.0' });
	const path = z.string().describe('Page name without ".md", e.g. "Server/SilverBullet"');

	server.registerTool(
		'search',
		{ description: 'Full-text search over titles, tags and content. Supports "phrases", #tag and in:folder filters. Returns ranked results with the matching section and snippet, plus folder/tag facets', inputSchema: { query: z.string(), limit: z.number().int().optional() } },
		({ query, limit }) => run(() => mdwiki.search(query, limit ?? 30))
	);
	server.registerTool(
		'list_pages',
		{ description: 'List pages, optionally below a path prefix', inputSchema: { prefix: z.string().optional() } },
		({ prefix }) => run(() => mdwiki.listPages(prefix ?? ''))
	);
	server.registerTool(
		'read_page',
		{ description: 'Read a page: content, frontmatter and content hash (use the hash as base_hash)', inputSchema: { path } },
		({ path }) => run(() => mdwiki.readPage(path))
	);
	server.registerTool(
		'write_page',
		{
			description:
				'Create or overwrite a page. With base_hash the write fails with a conflict if the page changed meanwhile; use "" to require that the page does not exist yet.',
			inputSchema: { path, content: z.string(), base_hash: z.string().optional() }
		},
		({ path, content, base_hash }) => run(() => mdwiki.writePage(path, content, base_hash))
	);
	server.registerTool(
		'append_to_page',
		{ description: 'Append text to a page (creates it when missing)', inputSchema: { path, content: z.string() } },
		({ path, content }) => run(() => mdwiki.appendToPage(path, content))
	);
	server.registerTool(
		'delete_page',
		{ description: 'Delete a page', inputSchema: { path } },
		({ path }) => run(() => mdwiki.deletePage(path))
	);
	server.registerTool('list_tags', { description: 'All tags with page counts', inputSchema: {} }, () =>
		run(() => mdwiki.listTags())
	);
	server.registerTool(
		'pages_by_tag',
		{ description: 'Pages carrying a tag', inputSchema: { tag: z.string() } },
		({ tag }) => run(() => mdwiki.pagesByTag(tag))
	);
	server.registerTool(
		'get_backlinks',
		{ description: 'Pages linking to a page', inputSchema: { path } },
		({ path }) => run(() => mdwiki.getBacklinks(path))
	);
	server.registerTool(
		'query_pages',
		{
			description:
				'Run the declarative page query used by the `pages` block: filter by tag, folder or links-to, sort, limit, and show as list, table or count. Same schema and filter names as search.',
			inputSchema: {
				tag: z.union([z.string(), z.array(z.string())]).optional(),
				folder: z.string().optional(),
				'links-to': z.string().optional(),
				sort: z.string().optional(),
				limit: z.number().int().optional(),
				show: z.enum(['list', 'table', 'count']).optional(),
				columns: z.array(z.string()).optional(),
				self: z.string().optional()
			}
		},
		({ self, ...query }) => run(() => mdwiki.queryPages(query, self ?? ''))
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
					throw new MdwikiError(400, 'bad_content', '"content_base64" is not valid base64');
				}
				return mdwiki.uploadAttachment(path, Buffer.from(content_base64, 'base64'));
			})
	);
	return server;
}
