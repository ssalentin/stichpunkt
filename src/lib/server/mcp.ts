import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BRAND } from '../brand';
import { mcpVersion } from '../version';
import { getCollections } from './collection-service';
import { AGGREGATE_FNS, FILTER_OPS } from './collections';
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

/** Like http.ts agentOf(): trim, cap at 120 characters. REST names the actor "api"; over MCP it is "mcp" unless the call says otherwise. */
function actorOf(agent?: string): string {
	const value = agent?.trim();
	return value ? value.slice(0, 120) : 'mcp';
}

/** Same service layer as REST; one server instance per request (stateless). */
export function buildMcpServer(mdwiki: Mdwiki): McpServer {
	const server = new McpServer({ name: BRAND, version: mcpVersion() }, { instructions: mdwiki.manifestInstructions() ?? undefined });
	const path = z.string().describe('Page name without ".md", e.g. "Server/SilverBullet"');
	const agent = z.string().optional().describe('Optional actor name; the owner and stand checks use it to compare the folder owner');
	const note = z.string().optional().describe('Optional note for the revision record (stored up to 500 characters)');
	const collectionId = z.string().describe('Collection id (UUID) from list_collections');
	const rowId = z.string().describe('Row id (UUID) from query_collection_rows or a row write');
	// Wire shape only; the semantics are enforced once, in CollectionStore. Keys are exact, case-sensitive property names from get_collection.
	const valuesSchema = z.record(z.string(), z.unknown());
	const filterSchema = z.object({ property: z.string(), op: z.enum(FILTER_OPS), value: z.unknown().optional() });
	const sortSchema = z.object({ property: z.string(), direction: z.enum(['asc', 'desc']).optional() });
	const groupSchema = z.object({ property: z.string(), direction: z.enum(['asc', 'desc']).optional() });
	const aggregatesSchema = z.record(z.string(), z.enum(AGGREGATE_FNS));
	const mcpAgent = z.string().optional().describe('Optional actor name recorded on the revision (default: "mcp")');

	server.registerTool(
		'search',
		{ description: 'Full-text search over titles, tags and content. Supports "phrases", #tag and in:folder filters. Returns ranked results with the matching section and snippet, layer per hit, per-page counts, plus folder/tag facets. Pages of the working layer are hidden unless include_working is true. Collection rows join the one ranked list: a row hit has an empty path and a `row` object with collectionId, collectionName, rowId, the matched property and an `href` that opens the row directly; `rows` counts the row matches and `total` includes them. Queries with #tag or in:folder stay page-only.', inputSchema: { query: z.string(), limit: z.number().int().optional(), include_working: z.boolean().optional() } },
		({ query, limit, include_working }) => run(() => mdwiki.search(query, limit ?? 30, include_working ?? false))
	);
	server.registerTool(
		'list_pages',
		{ description: 'List pages, optionally below a path prefix. Returns {pages,total,truncated}; working pages are hidden unless include_working is true.', inputSchema: { prefix: z.string().optional(), include_working: z.boolean().optional(), limit: z.number().int().optional(), offset: z.number().int().optional() } },
		({ prefix, include_working, limit, offset }) => run(() => mdwiki.listPagesResult(prefix ?? '', { includeWorking: include_working ?? false, limit, offset }))
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
		{ description: 'Delete a page. The history keeps a tombstone of the last version and its actor. MANIFEST is a fixed system page and cannot be deleted.', inputSchema: { path, agent, note } },
		({ path, agent, note }) => run(() => mdwiki.deletePage(path, agent, note))
	);
	server.registerTool(
		'move_page',
		{
			description:
				'Move or rename a page and rewrite the links that would stop resolving to it. Unique-basename links keep working and stay unchanged; `#Heading`, `|alias` and `![[...]]` survive. Fails with target_exists when the destination exists. MANIFEST is a fixed system page and cannot be moved. dry_run reports the same plan without writing.',
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
				'Read-only link audit: dead targets, ambiguous basenames, pages without incoming links (root pages are marked) and headings that do not exist. `path` limits the check to one page or folder; `include_hidden` also checks pages that are hidden from navigation.',
			inputSchema: { path: z.string().optional(), include_hidden: z.boolean().optional() }
		},
		({ path, include_hidden }) => run(() => mdwiki.checkLinks(path, include_hidden ?? false))
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
				'Revision list of a page, newest first: {id, hash, version, at, size, actor, actor_source, actor_name, tool, bytes_added, bytes_removed, warnings, note?, marker?}. Revisions are written by every MCP/REST write; direct file edits are not recorded. Read only.',
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
				self: z.string().optional(),
				include_working: z.boolean().optional()
			}
		},
		({ self, include_working, ...query }) => run(() => mdwiki.queryPages(query, self ?? '', include_working ?? false))
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
		'list_collections',
		{
			description:
				'List every collection (SQLite table) with its properties, row and view counts, ordered by name. Returns { databases: [...] } — collections are called "databases" in the REST API and the UI. Read the `id` from this output for every other collection tool.',
			inputSchema: {}
		},
		() => run(() => ({ databases: getCollections().list() }))
	);
	server.registerTool(
		'get_collection',
		{
			description:
				'Read one collection: properties (name, type, select options) and saved views. Views carry their group_by and aggregates. The property names returned here are the exact keys for `values` and for filters and sorts; unknown keys fail with 400 and change nothing.',
			inputSchema: { id: collectionId }
		},
		({ id }) => run(() => {
			const s = getCollections();
			return { ...s.get(id), views: s.views(id) };
		})
	);
	server.registerTool(
		'query_collection_rows',
		{
			description: `Query rows of a collection: filters [{property, op, value}] with ops ${FILTER_OPS.join(', ')}; sorts [{property, direction}] (default asc), stacking; limit (default 100, max 500) and offset; \`view\` applies a saved view. \`group_by\` {property, direction} groups the result: rows are ordered group-first and \`groups\` carries the whole-set count per key (raw stored value; dates by day; checkbox 'true'/'false'; multi_select the exact stored combination; empty and missing cells are the null key, ordered last). \`aggregates\` {property: fn} computes over the whole filtered set with fns ${AGGREGATE_FNS.join(', ')}: count and count_values always, sum and average for numbers, min and max for number/date/text/url/email. Returns {rows,total,properties,groups,aggregates}; groups and aggregates are null when inactive. An unknown property or an op/fn the property type does not support fails with 400 and changes nothing. Read only.`,
			inputSchema: {
				id: collectionId,
				filters: z.array(filterSchema).optional(),
				sorts: z.array(sortSchema).optional(),
				limit: z.number().int().optional(),
				offset: z.number().int().optional(),
				view: z.string().optional(),
				group_by: groupSchema.optional(),
				aggregates: aggregatesSchema.optional()
			}
		},
		({ id, filters, sorts, limit, offset, view, group_by, aggregates }) => run(() =>
			getCollections().query(id, {
				filters,
				sorts: sorts?.map((s) => ({ ...s, direction: s.direction ?? 'asc' })),
				limit,
				offset,
				view,
				group_by: group_by ? { property: group_by.property, direction: group_by.direction ?? 'asc' } : undefined,
				aggregates
			})
		)
	);
	server.registerTool(
		'create_collection_row',
		{
			description:
				'Create a row. `values` is keyed by exact property name (see get_collection); each value is validated against the property type with the same rules as REST — unknown properties, bad select options and malformed numbers fail with 400 and write nothing. Not idempotent: calling twice creates two rows. The returned `updated_at` is the `base_updated_at` to pass to the next update_collection_row.',
			inputSchema: { id: collectionId, values: valuesSchema, agent: mcpAgent }
		},
		({ id, values, agent }) => run(() => getCollections().createRow(id, values, actorOf(agent)))
	);
	server.registerTool(
		'update_collection_row',
		{
			description:
				'Update a row; only the properties present in `values` change and null clears a cell. With `base_updated_at` (the `updated_at` you read) the update fails with a conflict if the row changed meanwhile: the error carries `current` (the actual `updated_at`) — re-read the row, re-apply your change and retry. Omitted, the write is last-write-wins like REST. Validation is the same as create_collection_row.',
			inputSchema: { id: collectionId, row_id: rowId, values: valuesSchema, base_updated_at: z.string().optional(), agent: mcpAgent }
		},
		({ id, row_id, values, base_updated_at, agent }) => run(() => getCollections().updateRow(id, row_id, values, actorOf(agent), base_updated_at))
	);
	server.registerTool(
		'delete_collection_row',
		{
			description:
				'Delete a row. The revision history keeps the last values and the deleting actor. Returns {id, deleted: true}.',
			inputSchema: { id: collectionId, row_id: rowId, agent: mcpAgent }
		},
		({ id, row_id, agent }) => run(() => {
			getCollections().deleteRow(id, row_id, actorOf(agent));
			return { id: row_id, deleted: true };
		})
	);
	server.registerTool(
		'save_collection_view',
		{
			description:
				'Create a saved view of a collection: name plus optional filters, sorts, columns, group_by and aggregates — everything the UI can save. Validation is the same as REST: unknown properties and function/type violations fail with 400 and change nothing. The view is not revision-tracked, so `agent` is recorded nowhere. Returns the saved view; use its `id` as `view` in query_collection_rows.',
			inputSchema: {
				id: collectionId,
				name: z.string().optional(),
				filters: z.array(filterSchema).optional(),
				sorts: z.array(sortSchema).optional(),
				columns: z.array(z.string()).optional(),
				group_by: groupSchema.optional(),
				aggregates: aggregatesSchema.optional(),
				agent: mcpAgent
			}
		},
		({ id, name, filters, sorts, columns, group_by, aggregates }) => run(() =>
			getCollections().saveView(id, {
				name,
				filters,
				sorts,
				columns,
				group_by: group_by ? { property: group_by.property, direction: group_by.direction ?? 'asc' } : undefined,
				aggregates
			})
		)
	);
	server.registerTool(
		'collection_history',
		{
			description:
				'Revision list of a collection, or of one row with `row_id`, newest first: {id, row_id, at, actor, op, before, after}. Every MCP/REST row write records one revision. Read only.',
			inputSchema: { id: collectionId, row_id: rowId.optional(), limit: z.number().int().optional() }
		},
		({ id, row_id, limit }) => run(() => getCollections().history(id, row_id, limit ?? 50))
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
