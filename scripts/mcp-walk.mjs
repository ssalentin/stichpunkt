// Acceptance walk for the collection MCP tools (issue #83) over Streamable HTTP.
// Drives all seven tools against a running instance: list, get, filtered query, create,
// update, the 409 conflict with a stale base_updated_at, a validation refusal, delete
// and the revision history. Usage: node scripts/mcp-walk.mjs BASE_URL TOKEN
// The scratch row it creates is deleted again at the end; the history of that row is
// the last output. Set WALK_COLLECTION to pick a collection by name, otherwise the
// first collection with at least one row is used.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [base, token] = process.argv.slice(2);
const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
	requestInit: { headers: { authorization: `Bearer ${token}` } }
});
const client = new Client({ name: 'evidence-walk', version: '1' });
await client.connect(transport);

const text = (r) => JSON.parse(r.content[0].text);
const show = (label, value) => {
	console.log(`\n--- ${label} ---`);
	console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
};

const tools = (await client.listTools()).tools.map((t) => t.name);
show('collection tools offered over MCP', tools.filter((n) => n.includes('collection')));

const listed = text(await client.callTool({ name: 'list_collections', arguments: {} }));
show('list_collections (names and row counts)', listed.databases.map((d) => `${d.name}: ${d.row_count} rows`));

const wanted = process.env.WALK_COLLECTION;
const target = wanted
	? listed.databases.find((d) => d.name === wanted)
	: listed.databases.find((d) => d.row_count > 0);
if (!target) throw new Error(`no collection${wanted ? ` named ${wanted}` : ' with rows'} to walk`);

const schema = text(await client.callTool({ name: 'get_collection', arguments: { id: target.id } }));
show(`get_collection ${target.name} (property names and types)`, schema.properties.map((p) => `${p.name}: ${p.type}`));

const titleProp = schema.properties.find((p) => p.type === 'title').name;
const queried = text(await client.callTool({
	name: 'query_collection_rows',
	arguments: { id: target.id, filters: [{ property: titleProp, op: 'contains', value: 'S' }], sorts: [{ property: titleProp, direction: 'asc' }], limit: 3 }
}));
show(`query_collection_rows (filter ${titleProp} contains "S", sort asc, limit 3)`, { total: queried.total, rows: queried.rows.map((r) => r.values[titleProp]) });

const scratchValues = { [titleProp]: `MCP-EVIDENCE-SCRATCH-${Date.now()}` };
const created = text(await client.callTool({ name: 'create_collection_row', arguments: { id: target.id, values: scratchValues, agent: 'evidence-walk' } }));
show('create_collection_row (scratch row, agent "evidence-walk")', created);

const updated = text(await client.callTool({
	name: 'update_collection_row',
	arguments: { id: target.id, row_id: created.id, values: scratchValues, base_updated_at: created.updated_at }
}));
show('update_collection_row (fresh base_updated_at, no agent -> actor defaults to "mcp")', { id: updated.id, updated_at: updated.updated_at });

const conflict = await client.callTool({
	name: 'update_collection_row',
	arguments: { id: target.id, row_id: created.id, values: scratchValues, base_updated_at: created.updated_at }
});
show('update_collection_row with stale base_updated_at -> isError', { isError: conflict.isError, ...text(conflict) });

const bad = await client.callTool({
	name: 'create_collection_row',
	arguments: { id: target.id, values: { [titleProp]: 'x', '__nope__': 1 } }
});
show('create_collection_row with unknown property -> isError (validation parity with REST)', { isError: bad.isError, ...text(bad) });

const deleted = text(await client.callTool({ name: 'delete_collection_row', arguments: { id: target.id, row_id: created.id, agent: 'evidence-walk' } }));
show('delete_collection_row (scratch row removed)', deleted);

const hist = text(await client.callTool({ name: 'collection_history', arguments: { id: target.id, row_id: created.id } }));
show('collection_history for the scratch row (newest first, with actors)', hist.map((h) => ({ id: h.id, at: h.at, actor: h.actor, op: h.op })));

console.log('\nWALK COMPLETE');
