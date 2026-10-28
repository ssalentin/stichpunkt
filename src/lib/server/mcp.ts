import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BRAND } from '../brand';
import { mcpVersion } from '../version';
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
	const server = new McpServer({ name: BRAND, version: mcpVersion() }, { instructions: mdwiki.manifestInstructions() ?? undefined });
	const path = z.string().describe('Page name without ".md", e.g. "Server/SilverBullet"');
	const agent = z.string().optional().describe('Optional actor name; the owner and stand checks use it to compare the folder owner');
	const note = z.string().optional().describe('Optional note for the revision record (stored up to 500 characters)');

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
				'Create or overwrite a page. With base_hash the write fails with a conflict if the page changed meanwhile; use "" to require that the page does not exist yet. The response carries `warnings` (rule violations from the space MANIFEST, empty when everything fits); the write itself is never blocked by them.',
			inputSchema: { path, content: z.string(), base_hash: z.string().optional(), agent, note }
		},
		({ path, content, base_hash, agent, note }) => run(() => mdwiki.writePage(path, content, base_hash, agent, note))
	);
	server.registerTool(
		'append_to_page',
		{ description: 'Append text to a page (creates it when missing). The response carries `warnings` for the resulting page, like write_page.', inputSchema: { path, content: z.string(), agent, note } },
		({ path, content, agent, note }) => run(() => mdwiki.appendToPage(path, content, agent, note))
	);
	server.registerTool(
		'check_manifest',
		{
			description:
				'Read-only validation of MANIFEST.md against the current schema and the space: strict keys and enum values, `allowed_tags` without a `tag.define` in CONFIG, folders without a page, and folder keys that collide after normalisation. Returns {ok, issues:[{path, message}]}.',
			inputSchema: {}
		},
		() => run(() => mdwiki.checkManifest())
	);
	server.registerTool(
		'get_manifest',
		{ description: 'The space\'s agent manifest (MANIFEST page): machine-readable rules plus prose. Returns {exists:false} when the space has none.', inputSchema: {} },
		() => run(() => mdwiki.getManifest())
	);
	server.registerTool(
		'validate_page',
		{ description: 'Check page content against the manifest rules and return the same `warnings` as write_page, without writing anything', inputSchema: { path, content: z.string(), agent } },
		({ path, content, agent }) => run(() => mdwiki.validatePage(path, content, agent))
	);
	server.registerTool(
		'delete_page',
		{ description: 'Delete a page. The history keeps a tombstone of the last version and its actor.', inputSchema: { path, agent, note } },
		({ path, agent, note }) => run(() => mdwiki.deletePage(path, agent, note))
	);
	server.registerTool(
		'move_page',
		{
			description:
				'Move or rename a page and rewrite the links that would stop resolving to it. Unique-basename links keep working and stay unchanged; `#Heading`, `|alias` and `![[...]]` survive. Fails with target_exists when the destination exists. dry_run reports the same plan without writing.',
			inputSchema: {
				from: path,
				to: z.string().describe('New page name without ".md", e.g. "Archive/SilverBullet"'),
				dry_run: z.boolean().optional(),
				agent,
				note,
				overwrite: z.boolean().optional().describe('Replace an existing destination page (kept in .history) instead of failing with target_exists')
			}
		},
		({ from, to, dry_run, agent, note, overwrite }) => run(() => mdwiki.movePage(from, to, dry_run ?? false, agent, overwrite ?? false, note))
	);
	server.registerTool(
		'check_links',
		{
			description:
				'Read-only link audit: dead targets, ambiguous basenames, pages without incoming links (root pages are marked) and headings that do not exist. `path` limits the check to one page or folder; `include_working` also checks pages that are hidden from navigation.',
			inputSchema: { path: z.string().optional(), include_working: z.boolean().optional() }
		},
		({ path, include_working }) => run(() => mdwiki.checkLinks(path, include_working ?? false))
	);
	server.registerTool(
		'write_pages',
		{
			description:
				'Write several pages as one transaction. All base_hash values are checked before anything is written ("" = page must not exist); one mismatch returns 409 with every conflict and changes nothing. An unexpected disk error rolls the batch back. Warnings per page, never blocking.',
			inputSchema: {
				pages: z.array(z.object({ path, content: z.string(), base_hash: z.string().optional() })),
				dry_run: z.boolean().optional(),
				agent,
				note
			}
		},
		({ pages, dry_run, agent, note }) => run(() => mdwiki.writePages(pages, dry_run ?? false, agent, note))
	);
	server.registerTool(
		'history',
		{
			description:
				'Revision list of a page, newest first: {id, hash, at, size, marker?, agent?}. Revisions are written by every MCP/REST write; direct file edits are not recorded. Read only.',
			inputSchema: { path, limit: z.number().int().optional() }
		},
		({ path, limit }) => run(() => mdwiki.history(path, limit ?? 50))
	);
	server.registerTool(
		'activity',
		{
			description:
				'Read-only revision activity across all pages, newest first. Filters: since (ISO/date), actor (slug), folder (prefix), page (exact), limit. Records carry version, actor, actor_source, tool, byte counts, warning rules and an optional note.',
			inputSchema: {
				since: z.string().optional(),
				actor: z.string().optional(),
				folder: z.string().optional(),
				page: z.string().optional(),
				limit: z.number().int().optional()
			}
		},
		({ since, actor, folder, page, limit }) => run(() => mdwiki.activity(since, actor, folder, page, limit ?? 50))
	);
	server.registerTool(
		'diff',
		{
			description:
				'Unified diff between a revision and the page as it is now. `since` takes a revision id, a hash (prefix) or an ISO/date value (newest revision at or before it); without it the last revision is used. Read only.',
			inputSchema: { path, since: z.string().optional() }
		},
		({ path, since }) => run(() => mdwiki.diff(path, since))
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
		'evaluate',
		{
			description:
				'Evaluate one ${...} expression against the index and return the JSON value plus its rendered text form. `page` sets `this`. Read only.',
			inputSchema: { expr: z.string(), page: z.string().optional() }
		},
		({ expr, page }) => run(() => mdwiki.evaluateExpression(expr, page ?? ''))
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
