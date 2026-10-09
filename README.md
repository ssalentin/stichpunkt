# stichpunkt

A small, fast, self-hosted markdown wiki. Plain `.md` files are the database; the server renders pages to HTML, keeps an in-memory index, and exposes the same operations over a web UI, a REST API (`/api/v1`) and an MCP server (`/mcp`).

*Notes that stay in order.* — a fast, minimal markdown wiki where agents write and you read.

SvelteKit + TypeScript, `adapter-node`, one container (plus an internal Kroki container for server-side diagrams).

The display name, tagline and brand palette live in one place, `src/lib/brand.ts`; the PWA icons are the design set from the naming ticket (`static/icon*.png`, `static/icon.svg`, `static/icon-maskable.svg`, `static/wordmark.svg`). The repo, package, container and the environment variables were renamed to `stichpunkt` except for `MDWIKI_API_TOKEN`, the `X-Mdwiki-Zone` proxy header and the npm package name, which keep the old id as an internal contract.

## Features

- Directory of markdown files, folders are namespaces (`Server/SilverBullet.md` is page `Server/SilverBullet`). `Library/` is hidden from navigation.
- Frontmatter, CommonMark + GFM, `[[Page]]`, `[[Page|alias]]`, `[[Page#Heading]]`, `#tags` (inline + frontmatter `tags`), highlighted code. A wikilink displays the **page name**, not the typed path — the full path stays in the tooltip — and both pages keep their folder prefix only when their names collide.
- SilverBullet-only syntax (`${...}`, `space-lua`, `space-style`, `query`, `template`) renders as an inert chip and is never executed.
- SilverBullet helper widgets: exactly four known calls (`kb.section("tag")`, `kb.recent("tag", n)` incl. the `kb.safe` wrapper, `kb.header`, `kb.categories`) are recognised by pattern and rendered as built-in server-side widgets (categories come from `tag.define` in `CONFIG.md`). They are presets of the same query engine as the `pages` block. Nothing is evaluated; any other `${...}` stays an inert chip.
- **`pages` block (declarative queries)**: a fenced ```pages block with a small YAML body lists pages from the index. Filters: `tag` (one or a list, nested tags match), `folder` (path prefix, `this` = the page's folder) and `links-to` (`this` = backlinks of the page). `sort` accepts `title`, `modified`, `date` or any frontmatter key with `asc`/`desc`. `show` is `list`, `table` (with `columns`) or `count`; `limit` defaults to 50 and never exceeds 200. The body is checked against a strict schema (js-yaml CORE + zod): unknown keys or wrong types render the error with the block source. No expressions, no regex, nothing executed. The same engine is exposed as the `query_pages` MCP tool and `POST /api/v1/query`, using the same filter names as search (`#tag`, `in:folder`).
- Automatic `/tag/<name>` pages; a page named like a tag (or mapped via `tag.define { name=…, tagPage=… }` in `CONFIG.md`, parsed, not executed) gets a "Pages tagged #x" list.
- Mobile-first shell (bottom bar, bottom sheet), three columns on desktop, quick switcher (Ctrl/Cmd-K), full-text search, breadcrumbs. Task checkboxes are shown disabled.
- Search results are ranked cards: title, folder breadcrumb, the matching section with an anchor, a highlighted snippet, plus folder and tag facets to narrow the query (`#tag`, `in:folder`, `"phrases"`). The empty state offers the recently changed pages.
- Diagrams appear in place: client renderers (Mermaid, Vega-Lite, KaTeX) start fetching as soon as the page data is known, and the raw source is never shown first — a placeholder shimmer holds the space until the figure is ready. Server-rendered Kroki figures are unaffected.
- Frontmatter properties are not printed above the article; they live in the right rail on desktop and in the “More” sheet on mobile, next to outline, backlinks and tags.
- **Read-only web UI**: no editor, task toggling, upload or delete in the browser; `/_ui/*` answers 405 to every non-GET. Changes are made only by agents writing through MCP (`write_page`, `append_to_page`, `delete_page`, `upload_attachment`) or the equivalent token-protected REST API.
- Diagrams behind one registry (`src/lib/diagrams.ts`): Mermaid, Vega-Lite, KaTeX client-side and lazy; PlantUML, C4-PlantUML, Graphviz, D2, ERD, Nomnoml, Svgbob, Ditaa via Kroki (SVG cached by hash). Broken diagrams show the error and the source.
- Installable PWA; service worker caches the shell and the last ~50 visited pages for offline reading. Editing needs a connection.

## Run

```sh
cp .env.example .env            # set MDWIKI_API_TOKEN (openssl rand -base64 32)
mkdir space                      # or copy your markdown directory here
docker compose up -d --build
```

The sample `compose.yml` does not publish a port; put your reverse proxy in front (route the UI through your SSO, and `/mcp` + `/api` on a separate router **without** SSO — they are protected by the bearer token). The app serves HTTP; TLS is terminated by the proxy, so `PROTOCOL_HEADER=x-forwarded-proto` and `HOST_HEADER=x-forwarded-host` must be set (see `.env.example`), otherwise SvelteKit assumes `https` for generated URLs.

Without Docker: `npm ci && npm run build && SPACE_DIR=./space MDWIKI_API_TOKEN=… node build/index.js`.

### Reverse-proxy contract (important)

The web UI has no login; the proxy router for the UI must authenticate (e.g. Authelia). The router for `/mcp` and `/api` is protected by the bearer token and **must set the request header `X-Mdwiki-Zone: machine`** (Traefik: a `headers` middleware with `customRequestHeaders`, which overwrites any client-supplied value). The app then requires the token for *every* path on requests carrying that header. This closes path tricks like `/api/%2e%2e/_ui/page` (the URL parser turns `%2e%2e` into `..`, so a proxy matching the raw path `/api` could otherwise forward a request that the app sees as `/_ui/page`). The UI router must never set the header; a client adding it there only makes its own request stricter.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `SPACE_DIR` | `./space` (`/space` in the image) | markdown directory |
| `MDWIKI_API_TOKEN` | – | bearer token for `/mcp` and `/api`; **empty = both always answer 401** |
| `KROKI_URL` | empty | internal Kroki base URL; empty disables server-side diagrams (they show an error block) |
| `POLL_INTERVAL` | `10000` | ms between mtime polls for changes made outside the app (CIFS has no reliable inotify) |
| `MAX_WRITE_BYTES` | `1048576` | max size of a page write |
| `MAX_UPLOAD_BYTES` | `20971520` | max size of an attachment |
| `CACHE_DIR` | system temp (`/cache` in the image) | rendered diagram SVGs |
| `BODY_SIZE_LIMIT` | `25M` (image) | adapter-node request body limit; keep ≥ `MAX_UPLOAD_BYTES` |
| `PORT`, `HOST`, `PROTOCOL_HEADER`, `HOST_HEADER` | | adapter-node settings |

Allowed file extensions (read/write/upload): `md txt csv json pdf png jpg jpeg gif webp avif heic svg`. Paths with `..`, absolute paths, backslashes, dot-files, or symlinks leaving `SPACE_DIR` are rejected.

## API

All routes require `Authorization: Bearer <token>`. Page names are paths without `.md`.

| Method and path | Purpose |
| --- | --- |
| `GET /api/v1/search?q=&limit=` | full-text search |
| `GET /api/v1/pages?prefix=` | list pages |
| `GET /api/v1/pages/<path>` | `{content, frontmatter, hash, mtime}` |
| `PUT /api/v1/pages/<path>` | `{content, base_hash?}`; stale `base_hash` → **409** with `current`; `base_hash: ""` = must not exist |
| `POST /api/v1/pages/<path>` | `{content}` append |
| `DELETE /api/v1/pages/<path>` | delete |
| `GET /api/v1/tags`, `GET /api/v1/tags/<name>` | tags, pages by tag |
| `GET /api/v1/backlinks/<path>` | backlinks |
| `POST /api/v1/query` | run a `pages` query (`{tag?, folder?, links-to?, sort?, limit?, show?, columns?, self?}`) |
| `PUT /api/v1/attachments/<path>` | raw body upload, any allowed type |

MCP (`POST /mcp`, Streamable HTTP, stateless): `search`, `list_pages`, `read_page`, `write_page`, `append_to_page`, `delete_page`, `list_tags`, `pages_by_tag`, `get_backlinks`, `query_pages`, `upload_attachment`.

```sh
claude mcp add --transport http stichpunkt https://stichpunkt.example.org/mcp --header "Authorization: Bearer $MDWIKI_API_TOKEN"
```

## Token rotation

1. Generate a new token: `openssl rand -base64 32`; store it in your password manager.
2. Put it into `.env` as `MDWIKI_API_TOKEN`.
3. `docker compose up -d stichpunkt` (recreates the container; the web UI is unaffected).
4. Update the clients (agent runtimes, `claude mcp add … --header`). The old token stops working immediately.

## Stop

`docker compose stop` (keep containers), `docker compose down` (remove containers; `space/` is a bind mount and is never touched), `docker compose down -v` also drops the diagram cache volume.

## Example knowledge base

`examples/knowledge/` is a generated, content-free example space that shows every feature (wikilinks, tags and tag pages, tables, tasks, code, attachments, inert SilverBullet syntax, Mermaid, Vega-Lite, KaTeX, all Kroki diagram types, broken diagrams, short and long pages). Try it: `SPACE_DIR=examples/knowledge node build/index.js` (with `KROKI_URL` set for the server-side diagrams).

## Develop and test

```sh
npm ci
npm test            # vitest: renderer, index, polling, conflicts, path safety, auth, MCP
npm run build
```

Test fixtures live in `test/fixtures/space` (synthetic; no real content). Notes:

- Writes inside one process are serialised per file; optimistic concurrency via content hash protects against *other* writers, but the check-then-rename window against an external process writing at the same instant cannot be closed on a plain directory.
- The web UI has no login of its own; put it behind SSO. It is read only, so even an unauthenticated visitor cannot change content through it.
- Page names starting with `api` or `mcp` as the first segment are not reachable through the UI (those prefixes are reserved for the token-protected interfaces).
