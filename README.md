<p align="center">
  <img src="assets/logo.png" alt="quill-mcp" width="200" />
</p>

# quill-mcp

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for managing a markdown notes vault. Gives AI assistants the ability to create, read, update, delete, move, search, and organize markdown notes on the local filesystem.

---

## Project Context

> This section exists so an AI agent can restore full project context after a context window reset.

### What This Is

quill-mcp is a **stdio-based MCP server** written in TypeScript. It runs as a child process started by an MCP client (Qoder, Claude Desktop, etc.) and exposes **100 tools** for managing a local markdown vault with a persistent memory intelligence layer. It also supports an optional HTTP transport for multi-device remote access. It is NOT a standalone app — it is always launched and managed by the host MCP client.

### GitHub

- **Repo:** https://github.com/Manolito016/quill-mcp
- **License:** MIT

### Runtime Environment

- **Node.js:** >= 18.0.0 (v22 LTS recommended; v24 has a silent crash bug on Windows — avoid)
- **Vault location:** Configurable via CLI arg, env var, or config file (see Configuration section)

### Architecture

```
Client (Qoder/Claude) ←stdio→ index.ts → tool handlers → vault filesystem
Browser/Remote client ←HTTP→  ↑         → memory intelligence layer (BM25, conflict detection, checkpoints)
```

- **Transport:** stdio (JSON-RPC over stdin/stdout) + optional HTTP (Streamable HTTP transport)
- **SDK:** `@modelcontextprotocol/sdk` v1.29+
- **Validation:** Zod schemas on every tool input
- **Error handling:** Every tool handler is wrapped in `safeHandler()` — catches exceptions and returns MCP error responses instead of crashing the process
- **Crash protection:** `uncaughtException` and `unhandledRejection` listeners registered at startup
- **Keepalive:** 60-second heartbeat interval prevents idle pipe timeouts

### Tool Registration Pattern

Each tool is a separate file in `src/tools/` exporting:
```typescript
export const name = "tool_name";
export const description = "...";
export const inputSchema = z.object({ ... });
export async function handler(params) { return { content: [...] }; }
```

All tools are registered in `src/index.ts` via `registerTool()` which wraps each handler in `safeHandler()`.

### Vault Path Resolution (priority order)

1. CLI argument: `node dist/index.js D:/vault`
2. Environment variable: `NOTES_VAULT_PATH`
3. `vault.config.json`: `{ "vaultPath": "D:/vault" }` (simplest — just edit the file)
4. `.env` file: `NOTES_VAULT_PATH=D:/vault`

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Soft delete | `.trash/` folder | Compatible with markdown editors, recoverable |
| File watching | Polling (mtime+size) | No external deps, exFAT-safe |
| Path security | `resolve()` + prefix check | Blocks traversal attacks |
| Trash exclusion | Skip `.trash` in list/search/graph | Trash contents don't pollute results |
| Watcher interval | Configurable via `NOTES_WATCH_INTERVAL` | Default 5000ms, adjustable |

### Project Structure

```
d:\quill-mcp\
├── src/
│   ├── index.ts                  # Entry point, server setup, tool registration
│   ├── tools/                    # One file per MCP tool (75 tools)
│   │   ├── read-note.ts
│   │   ├── write-note.ts
│   │   ├── create-note.ts
│   │   ├── append-note.ts
│   │   ├── delete-note.ts        # Soft delete (permanent=false) or hard delete
│   │   ├── delete-folder.ts      # Soft delete with recursive option
│   │   ├── batch-delete.ts       # Batch soft/permanent delete
│   │   ├── restore-note.ts       # Restore from .trash/
│   │   ├── list-trash.ts         # Browse .trash/ contents
│   │   ├── move-note.ts
│   │   ├── copy-note.ts
│   │   ├── list-notes.ts         # Excludes .trash/
│   │   ├── search-notes.ts       # Full-text + regex, excludes .trash/
│   │   ├── search-by-name.ts
│   │   ├── note-info.ts
│   │   ├── create-folder.ts
│   │   ├── rename-folder.ts
│   │   ├── extract-tags.ts
│   │   ├── extract-links.ts      # Wiki links [[...]] and markdown links
│   │   ├── extract-callouts.ts   # Obsidian callout parsing ([!type], foldable)
│   │   ├── find-backlinks.ts
│   │   ├── watch-changes.ts      # Returns detected external file changes
│   │   ├── session-history.ts    # View session mutation history
│   │   ├── create-template.ts    # daily, meeting, project, idea templates
│   │   ├── read-frontmatter.ts
│   │   ├── write-frontmatter.ts
│   │   ├── update-frontmatter.ts
│   │   ├── vault-status.ts
│   │   ├── batch-move.ts
│   │   ├── quill-write.ts        # Memory intelligence: write typed memory
│   │   ├── quill-record-decision.ts
│   │   ├── quill-record-lesson.ts
│   │   ├── quill-record-discovery.ts
│   │   ├── quill-retrieve.ts     # Smart BM25 retrieval
│   │   ├── quill-recall.ts       # Quick project recall
│   │   ├── quill-detect-conflicts.ts
│   │   ├── quill-resolve-conflict.ts
│   │   ├── quill-checkpoint.ts   # Context checkpoint
│   │   ├── quill-restore.ts      # Context restoration
│   │   ├── quill-consolidate.ts  # Memory consolidation
│   │   ├── quill-audit.ts        # Audit log query
│   │   ├── quill-session-start.ts
│   │   ├── quill-session-end.ts
│   │   ├── create-task.ts        # Create markdown checkbox tasks
│   │   ├── complete-task.ts      # Toggle task completion
│   │   ├── list-tasks.ts         # List tasks with filtering
│   │   ├── query-tasks.ts        # Advanced task queries
│   │   ├── tools.test.ts         # Core tool test suite
│   │   ├── tools-full.test.ts    # Expanded test suite (49 cases)
│   │   └── stdio-integration.test.ts  # MCP stdio integration test
│   └── utils/
│       ├── vault.ts              # Vault root resolution, path safety, initVault()
│       ├── vault.test.ts
│       ├── trash.ts              # moveToTrash, restoreFromTrash, isInTrash, listTrash
│       ├── trash.test.ts         # Trash utility tests (10 cases)
│       ├── watcher.ts            # VaultWatcher singleton, polling based change detection
│       ├── graph.ts              # Graph engine: BFS, centrality, communities, orphans, bridges
│       ├── logger.ts             # Structured JSON logger
│       ├── links.ts              # Link extraction utilities (wiki + markdown)
│       ├── callouts.ts           # Obsidian callout parsing (13 types + aliases)
│       ├── session-tracker.ts    # Session mutation tracking
│       ├── tokens.ts             # Token estimation utilities
│       ├── frontmatter.ts        # YAML frontmatter parsing (enhanced: nested objects, multi-line arrays)
│       ├── memory-id.ts          # ULID generation (Crockford Base32, mem_ prefix)
│       ├── memory-id.test.ts
│       ├── memory-schema.ts      # Zod schemas, 16 memory types, 8 statuses, confidence
│       ├── memory-schema.test.ts
│       ├── lifecycle.ts          # State machine: valid transitions, resurrection prevention
│       ├── lifecycle.test.ts
│       ├── config.ts             # Config resolver (vault.config.json → env → defaults)
│       ├── audit-log.ts          # Append-only JSON audit trail
│       ├── metadata-index.ts     # In-memory cache, secondary indexes, BM25 inverted index
│       ├── retrieval-engine.ts   # BM25 scoring, composite ranking, context budget modes
│       ├── conflict-engine.ts    # Field-based conflict detection, resolution, supersession
│       ├── checkpoint.ts         # Checkpoint create/restore for context reconstruction
│       ├── consolidation.ts      # Jaccard duplicate detection, promotion, archival
│       ├── consolidation.test.ts
│       ├── task-index.ts         # Task parsing, indexing, and filtering
│       ├── task-index.test.ts    # Task index tests
├── dist/                         # Compiled JS output (gitignored)
├── assets/
│   └── logo.png                  # Quill logo
├── skills/
│   └── note-graph.md             # /note-graph skill definition
├── canvas/
│   └── note-graph.canvas.tsx     # Knowledge graph canvas visualization
├── .env.example                  # Environment variable documentation
├── .prettierrc                   # Code formatting config
├── .gitignore
├── tsconfig.json
├── package.json
├── LICENSE                       # MIT
├── README.md                     # This file
└── CONTRIBUTING.md
```

### Development Commands

```bash
npm run build          # Compile TypeScript to dist/
npm run dev            # Watch mode compilation
npm start              # Run the server (node dist/index.js)
npm test               # Run vitest
npm run lint           # ESLint check
npm run lint:fix       # ESLint auto-fix
npm run format         # Prettier format
npm run format:check   # Prettier check
```

### Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `NOTES_VAULT_PATH` | Path to the markdown vault | (required via CLI arg or .env) |
| `NOTES_WATCH_INTERVAL` | File watcher polling interval in ms | `5000` |
| `LOG_LEVEL` | Logging level (debug/info/warn/error) | `info` |

### Known Limitations

- **No chokidar:** File watcher uses custom polling to avoid adding dependencies. Inherent latency vs native fs events.
- **Single vault:** One vault per server instance. No multi-vault support.

---

## Features

- **Read** — read note contents by path
- **Write** — create or overwrite a note (auto-creates parent directories)
- **Create** — create a new note (fails if it already exists)
- **Append** — append content to an existing note
- **Soft Delete** — move notes to `.trash/` (recoverable) or permanently delete
- **Restore** — recover notes from `.trash/` back to their original location
- **Delete Folder** — remove a folder (soft or permanent)
- **Move / Rename** — move or rename notes within the vault
- **Copy** — copy a note to a new location
- **List** — list files and folders with pagination support
- **Search** — full-text search with regex support and pagination
- **Search by Name** — find notes by filename pattern
- **Note Info** — get metadata (size, created/modified dates) for any file or folder
- **Create Folder** — create directories in the vault
- **Rename Folder** — rename existing folders
- **Extract Tags** — extract hashtags from notes
- **Templates** — create notes from predefined templates (daily, meeting, project, idea)
- **Frontmatter** — read and write YAML frontmatter in notes
- **Batch Delete** — delete multiple notes at once (soft or permanent)
- **Batch Move** — move multiple notes at once
- **Knowledge Graph** — extract links, find backlinks, discover orphans
- **Extract Callouts** — parse Obsidian callout syntax from notes
- **Session History** — track vault mutations across sessions
- **File Watching** — detect external changes from other editors or tools
- **Trash Management** — list and restore items from the trash
- **Vault Status** — check if the vault is accessible and healthy
- **Task Management** — create, complete, list, and query tasks from markdown checkboxes across the vault
- **Kanban Boards** — markdown-based Kanban boards with columns, task metadata, drag-drop movement, and archiving
- **Recurring Tasks** — automated task creation based on schedules (daily, weekly, monthly, yearly, custom intervals)
- **Webhooks & Events** — subscribe external services to vault change notifications via HTTP webhooks
- **Semantic Search** — find conceptually related notes using TF-IDF vector embeddings and cosine similarity
- **Hybrid Search** — combined BM25 + semantic ranking for superior retrieval quality with configurable balance

### Task Management

quill-mcp includes built-in task management using standard markdown checkboxes. Tasks are discovered by scanning all `.md` files in the vault (excluding `.trash/`).

- **Standard Format** — uses `- [ ]` for pending and `- [x]` for complete tasks
- **Metadata Support** — due dates (`📅 YYYY-MM-DD`), tags (`🏷️ tag1,tag2`), and priority (`📌 high/medium/low`)
- **Task Index** — in-memory index with cache invalidation via the file watcher for fast queries
- **Flexible Filtering** — filter by status, project (folder), tags, priority, due date range, and free-text search
- **Section Support** — create tasks under specific headings within notes

**Example task with metadata:**
```markdown
- [ ] Submit quarterly report 📅 2026-10-20 🏷️ work,urgent 📌 high
```

### Recurring Tasks

Recurring tasks extend the task management system with automated task creation based on schedules. Tasks use the recurrence emoji marker (🔄) followed by a pattern.

**Supported patterns:**
- `daily` — every day
- `weekly` — every 7 days
- `weekly:mon,wed,fri` — specific weekdays
- `monthly` — same day each month
- `monthly:15` — specific day of month
- `yearly` — same date each year
- `every:N:d|w|m|y` — custom interval (N days/weeks/months/years)

**Example recurring tasks:**
```markdown
- [ ] Water plants 🔄 every:3:d
- [ ] Team standup 🔄 weekly:mon,wed,fri
- [ ] Pay rent 🔄 monthly:1
- [ ] Birthday party 🔄 yearly
- [ ] Sprint review 🔄 every:2:w
```

**Features:**
- **Auto-creation** — completing a recurring task automatically inserts the next occurrence
- **Pause/Resume** — temporarily suspend and reactivate recurring tasks
- **Skip** — advance past an occurrence without completing it (e.g., holidays)
- **Overdue tracking** — recurring tasks show as overdue when past their next due date
- **Month boundary handling** — correctly handles varying month lengths and leap years
- **Persistent state** — recurrence state survives across sessions via `.quill-recurrence-state.json`

### Webhooks & Event System

quill-mcp includes an event bus and webhook system that allows external services to receive real-time notifications when vault changes occur. Events are emitted automatically by note/folder operations and delivered as HTTP POST requests to subscribed webhook endpoints.

**Event types:**
- `note_created` — emitted after `create_note` succeeds
- `note_updated` — emitted after `write_note` or `append_note` succeeds
- `note_deleted` — emitted after `delete_note` succeeds
- `folder_created` — emitted after `create_folder` succeeds
- `folder_deleted` — emitted after `delete_folder` succeeds

**Webhook tools:**
- `subscribe_webhook` — register a new webhook URL with event filters and optional HMAC signing secret
- `list_webhooks` — list all active webhook subscriptions
- `delete_webhook` — remove a webhook subscription by ID
- `test_webhook` — send a test payload to verify endpoint connectivity
- `trigger_webhook` — manually trigger a specific webhook with a custom event
- `emit_event` — manually emit a custom event into the event bus

**Example: Subscribe to note changes**
```json
{
  "url": "https://example.com/webhook",
  "events": ["note_created", "note_updated"],
  "secret": "optional-signing-secret"
}
```

**Webhook payload format:**
```json
{
  "event": "note_updated",
  "timestamp": "2026-10-17T12:00:00Z",
  "data": {
    "path": "notes/example.md",
    "size": 1234,
    "tags": ["tag1", "tag2"]
  }
}
```

**Security considerations:**
- Use HTTPS endpoints in production to protect payload contents and signing secrets
- When a signing secret is provided, an `X-Webhook-Signature` header is included with HMAC-SHA256 of the body
- Verify the signature on your server by computing `sha256=<HMAC>` and comparing with the header value
- Webhook subscriptions are stored in `.webhooks.json` at the vault root (excluded from `list_notes`)
- Delivery is async (non-blocking) with 3 retry attempts using exponential backoff
- Rate limited to 100 deliveries per minute per webhook

### Memory Intelligence Layer

quill-mcp includes a persistent memory intelligence layer that transforms the vault into an agent memory system:

- **16 Memory Types** — FACT, DECISION, CONSTRAINT, ARCHITECTURE, LESSON, DISCOVERY, ERROR, SOLUTION, and more
- **Lifecycle State Machine** — ACTIVE → CONFIRMED → ARCHIVED with transition validation and resurrection prevention
- **BM25 Smart Retrieval** — keyword-ranked retrieval with metadata boosting (project match, importance, recency, confidence)
- **Context Budget Modes** — compact (5 results), standard (20), deep (100) for token-aware retrieval
- **Conflict Detection** — field-based detection of contradictory same-entity memories within a project
- **Memory Consolidation** — Jaccard duplicate detection, importance promotion, obsolete archival
- **Checkpoints** — structured markdown checkpoints for context reconstruction after compaction
- **Audit Trail** — append-only JSON log of all memory mutations with rotation
- **Secret Detection** — automatic scanning for API keys, tokens, and passwords before writes
- **Project Isolation** — memories scoped by project with hard filtering
- **ULID Identifiers** — time-sortable unique IDs (mem_ prefix, Crockford Base32)
- **Zod Validation** — runtime schema validation for all memory frontmatter

## Security

- **Path traversal defense:** All paths are resolved relative to the configured vault root. Any attempt to access files outside the vault is rejected.
- **Symlink/junction defense:** Existing paths are verified via `realpath()` to prevent symlink escapes. Write destinations validate their deepest existing parent.
- **Vault root protection:** No tool can delete, move, or overwrite the vault root itself.
- **Protected directories:** Internal directories (`.trash`, `.git`, `.quill-sessions`, `node_modules`) cannot be targeted by delete/move/rename operations.
- **Stdio isolation:** All diagnostic logging goes to stderr. Stdout contains JSON-RPC only, ensuring clean MCP communication.
- **Crash protection:** Uncaught exceptions are logged and trigger a clean nonzero exit. Tool handler errors are caught and returned as MCP error responses.

## Setup

```bash
git clone https://github.com/Manolito016/quill-mcp.git
cd quill-mcp
npm install
npm run build
```

## Add to Your MCP Client

### Option 1: Using vault.config.json (simplest)

Edit `vault.config.json` in the project root and set your vault path:

```json
{
  "vaultPath": "D:/your/vault/path"
}
```

The default value is `"enter the path"` — replace it with your actual vault location.

If `vaultPath` is empty or still says `"enter the path"`, the server will auto-detect common vault locations (`D:/vault`, `~/Documents/vault`, etc.).

Then add the server to your MCP client config (no path in args needed):

```json
{
  "mcpServers": {
    "notes": {
      "command": "node",
      "args": ["d:/quill-mcp/dist/index.js"]
    }
  }
}
```

### Option 2: Using CLI argument

Add the server to your MCP client configuration and point it to your vault:

```json
{
  "mcpServers": {
    "notes": {
      "command": "node",
      "args": ["d:/quill-mcp/dist/index.js", "D:/vault"]
    }
  }
}
```

Replace `D:/vault` with the path to your notes folder. The AI agent will automatically start the server and use the tools.

## Configuration

The vault path is resolved from these sources (in priority order):

| Priority | Method | How |
|----------|--------|-----|
| 1 (highest) | CLI argument | `"args": ["...", "D:/vault"]` in MCP config |
| 2 | Environment variable | Set `NOTES_VAULT_PATH` in your system env |
| 3 | Config file | Edit `vault.config.json` → `{ "vaultPath": "D:/vault" }` |
| 4 (lowest) | `.env` file | Add `NOTES_VAULT_PATH=D:/vault` to the project `.env` |

The **config file** approach is the simplest — just edit `vault.config.json` and set your vault path. No env vars, no CLI args needed.

### HTTP Mode (Multi-Device Sync)

quill-mcp supports an HTTP transport alongside the default stdio transport, enabling remote access from multiple devices, browser-based clients, or any HTTP-capable MCP client. Both transports run simultaneously — stdio for local clients and HTTP for remote access.

**Architecture:**
```
Local Client  ←stdio→  quill-mcp  ←→  Vault filesystem
Remote Client ←HTTP→   quill-mcp  ←→  Vault filesystem
```

#### Enabling HTTP Mode

**Option 1: CLI flags**
```bash
node dist/index.js --http --port 3000 --host 127.0.0.1
```

**Option 2: Environment variables**
```bash
QUILL_HTTP_ENABLED=true QUILL_HTTP_PORT=3000 node dist/index.js
```

**Option 3: vault.config.json**
```json
{
  "vaultPath": "D:/vault",
  "http": {
    "enabled": true,
    "port": 3000,
    "host": "127.0.0.1",
    "auth_token": "your-secret-token",
    "cors_origins": ["http://localhost:3001"]
  }
}
```

**Option 4: Startup scripts**
```bash
# Linux/macOS
./start-http.sh --port 3000

# Windows
start-http.bat --port 3000
```

#### HTTP Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/mcp` | POST | MCP JSON-RPC endpoint (Streamable HTTP transport) |
| `/mcp` | GET | SSE stream for server-initiated notifications |
| `/mcp` | DELETE | Session termination |
| `/health` | GET | Health check with uptime and memory stats |
| `/status` | GET | Detailed server status and request statistics |
| `/tools` | GET | List all available MCP tools |

#### Usage Examples

**Health check:**
```bash
curl http://localhost:3000/health
```

**List tools:**
```bash
curl http://localhost:3000/tools
```

**MCP initialize (creates a session):**
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "method": "initialize",
    "id": 1,
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": { "name": "my-client", "version": "1.0.0" }
    }
  }'
```

**With authentication:**
```bash
curl http://localhost:3000/health \
  -H "Authorization: Bearer your-secret-token"
```

#### Configuration Reference

| Setting | Env Variable | CLI Flag | Default | Description |
|---------|-------------|----------|---------|-------------|
| `http.enabled` | `QUILL_HTTP_ENABLED` | `--http` | `false` | Enable HTTP transport |
| `http.port` | `QUILL_HTTP_PORT` | `--port` | `3000` | HTTP listen port |
| `http.host` | `QUILL_HTTP_HOST` | `--host` | `127.0.0.1` | Bind address |
| `http.auth_token` | `QUILL_AUTH_TOKEN` | `--auth-token` | none | Bearer token for auth |
| `http.cors_origins` | — | — | `[]` | Allowed CORS origins |

#### Security

- **Default bind: `127.0.0.1`** — only accessible from localhost. This is intentional.
- **Auth token required for remote access** — when binding to `0.0.0.0`, set `auth_token` to require Bearer token authentication on all endpoints.
- **Rate limiting** — 1000 requests per minute per IP address.
- **Request size limit** — 10MB max request body.
- **CORS** — configure `cors_origins` to allow browser-based clients from specific origins.
- **Request logging** — all HTTP requests are logged with method, path, status, and duration.

#### stdio vs HTTP Mode

| Feature | stdio | HTTP |
|---------|-------|------|
| Local MCP clients | Yes | Yes |
| Remote access | No | Yes |
| Multi-device | No | Yes |
| Browser clients | No | Yes (with CORS) |
| Authentication | N/A | Bearer token |
| Requires child process | Yes | No (standalone) |
| SSE streaming | No | Yes |

Both transports can run simultaneously. The stdio transport is always active for local MCP clients. HTTP is opt-in.

### Semantic Search

quill-mcp includes semantic search powered by TF-IDF (term frequency–inverse document frequency) vector embeddings with cosine similarity. This finds notes that are conceptually related to a query, going beyond simple keyword matching.

**How it works:**
- Notes are tokenized, filtered for stop words, and converted to TF-IDF vectors
- Long notes are automatically chunked into sections (max ~512 tokens each)
- Vectors are L2-normalized for efficient cosine similarity comparison
- Embeddings are cached to `.embeddings/` at vault root for fast subsequent searches
- Only recomputed when note content changes (content-hash-based invalidation)

**Tools:**
- `semantic_search` — find notes similar to a text query
- `find_similar` — find notes similar to a specific reference note
- `index_vault` — manually trigger a full vault re-index
- `embedding_status` — show indexing progress and statistics

**Usage examples:**
```
semantic_search(query="machine learning algorithms", top_k=5, min_similarity=0.1)
find_similar(path="notes/deep-learning.md", top_k=10)
index_vault(force=true)
embedding_status()
```

**Parameters:**
- `top_k` — maximum results to return (default: 10, max: 50)
- `min_similarity` — cosine similarity threshold 0-1 (default: 0.1)
- `project` — filter to a specific directory (semantic_search only)
- `tags` — filter to notes with specific tags (semantic_search only)

**Storage format:**
- Embeddings stored as `.embeddings/<path-hash>_c<chunk>.json`
- Each file contains: vector, content hash, timestamp, vocabulary
- Index metadata in `.embeddings/index.json`
- Vault-specific (vault path included in hash to prevent cross-vault contamination)

**Performance:**
- Indexing is async and non-blocking
- Bounded concurrency (8 files at a time) during indexing
- Incremental updates via file watcher integration
- Typical vaults (500-1000 notes) index in under 1 second

### Hybrid Search

Hybrid search combines BM25 full-text ranking with semantic TF-IDF similarity for superior retrieval quality. It leverages the strengths of both approaches: BM25 excels at precise keyword matching, while semantic search captures conceptual relationships.

**Scoring formula:**
```
final_score = alpha * bm25_score + (1 - alpha) * semantic_score
```

Both component scores are normalized to [0, 1] using min-max normalization before combining. The `alpha` parameter controls the balance:
- `alpha = 0.5` (default) — balanced blend of keyword and semantic matching
- `alpha = 1.0` — pure BM25 (keyword-focused, good for exact term searches)
- `alpha = 0.0` — pure semantic (concept-focused, good for exploratory queries)

**When to use hybrid search vs. pure BM25 or semantic:**
- **Hybrid** (default) — best general-purpose retrieval; catches both keyword matches and conceptual neighbors
- **Pure BM25** (`alpha=1`) — when you need exact term matches (e.g., searching for specific error codes, variable names)
- **Pure semantic** (`alpha=0`) — when you want conceptual similarity regardless of wording (e.g., "how do I handle auth?" matching "authentication middleware setup")

**Tools:**
- `hybrid_search` — search notes using combined BM25 + semantic ranking
- `hybrid_search_similar` — find notes similar to a reference note using hybrid ranking

**Usage examples:**
```
hybrid_search(query="neural network training", top_k=10, alpha=0.5, min_score=0.3)
hybrid_search(query="authentication middleware", alpha=0.7, project="projects/webapp", tags=["backend"])
hybrid_search(query="recent design decisions", boost_recent=true, min_score=0.2)
hybrid_search_similar(path="notes/architecture.md", top_k=5, alpha=0.5)
```

**Parameters (hybrid_search):**
- `query` — search query text (required)
- `top_k` — maximum results (default: 10, max: 50)
- `alpha` — BM25 vs semantic weight 0-1 (default: 0.5)
- `min_score` — minimum combined score threshold 0-1 (default: 0.3)
- `project` — filter to a specific directory
- `tags` — filter to notes with specific tags
- `boost_recent` — boost recently modified notes with exponential decay (default: false)

**Parameters (hybrid_search_similar):**
- `path` — vault-relative path to the reference note (required)
- `top_k` — maximum results (default: 10, max: 50)
- `alpha` — BM25 vs semantic weight 0-1 (default: 0.5)
- `min_score` — minimum combined score threshold 0-1 (default: 0.1)
- `project` — filter to a specific directory
- `tags` — filter to notes with specific tags

**Performance:**
- Both BM25 and semantic indexes are loaded in parallel
- 5-second timeout per index; falls back to available index if one fails
- Results are deduplicated by path (highest combined score wins)

## Tools Reference

| Tool | Description | Parameters |
|------|-------------|------------|
| `read_note` | Read the content of a note | `path` — relative path in vault |
| `write_note` | Create or overwrite a note | `path`, `content` |
| `create_note` | Create a new note (fails if exists) | `path`, `content` |
| `append_note` | Append content to an existing note | `path`, `content` |
| `delete_note` | Move note to trash (recoverable) | `path`, `permanent` (default `false`) |
| `delete_folder` | Move folder to trash (recoverable) | `path`, `recursive` (default `true`), `permanent` (default `false`) |
| `move_note` | Move or rename a note | `from`, `to` |
| `copy_note` | Copy a note to a new location | `from`, `to` |
| `rename_folder` | Rename a folder | `from`, `to` |
| `list_notes` | List files in a directory | `path` (default `.`), `recursive` (default `false`), `limit`, `offset` |
| `search_notes` | Full-text search with regex support | `query`, `path` (default `.`), `fileExtension` (default `.md`), `useRegex` (default `false`), `limit`, `offset`, `showTokenEstimate` (default `false`) |
| `search_by_name` | Search by filename pattern | `pattern`, `path` (default `.`), `recursive` (default `true`) |
| `discover` | Ranked filename/path/metadata/heading/content discovery | `query`, `folder`, `limit`, `cursor`, `types`, `search_fields` |
| `search_files` | Indexed filename/path substring or glob search | `pattern`, `folder`, `match`, `recursive`, `include_path_matches`, `limit`, `cursor` |
| `search_by_tag` | YAML tag discovery with AND/OR matching | `tags`, `operator`, `folder`, `limit`, `cursor` |
| `list_folder` | Bounded folder browsing with concise metadata | `folder`, `recursive`, `include_metadata`, `limit`, `cursor` |
| `refresh_knowledge_index` | Explicitly rebuild the discovery catalog | none |
| `extract_tags` | Extract hashtags from a note | `path` |
| `read_frontmatter` | Read YAML frontmatter from a note | `path` |
| `write_frontmatter` | Write YAML frontmatter to a note (replaces all) | `path`, `frontmatter` (object) |
| `update_frontmatter` | Update specific frontmatter keys (preserves others) | `path`, `updates` (object) |
| `create_from_template` | Create note from template | `path`, `template` (daily/meeting/project/idea), `title` |
| `note_info` | Get file/folder metadata | `path` |
| `create_folder` | Create a new folder | `path` |
| `batch_delete` | Delete multiple notes (soft or permanent) | `paths` (array), `permanent` (default `false`) |
| `batch_move` | Move multiple notes at once | `moves` (array of `{from, to}`) |
| `vault_status` | Check vault health and accessibility | (none) |
| `extract_links` | Extract wiki and markdown links from a note | `path` |
| `find_backlinks` | Find all notes linking to a target note | `path` (note name without .md), `searchPath` (default `.`) |

| `restore_note` | Restore a note from trash to original location | `path` (path inside .trash/) |
| `list_trash` | List all items in the trash | (none) |
| `watch_changes` | Check for external file changes since last poll | `clear` (default `true`) |

| `semantic_search` | Find notes by semantic similarity (TF-IDF) | `query`, `top_k` (default 10), `min_similarity` (default 0.1), `project`, `tags` |
| `find_similar` | Find notes similar to a specific note | `path`, `top_k` (default 10), `min_similarity` (default 0.1) |
| `index_vault` | Manually trigger full vault indexing | `force` (default `false`) |
| `embedding_status` | Show indexing progress and statistics | (none) |
| `hybrid_search` | Combined BM25 + semantic search | `query`, `top_k` (default 10), `alpha` (default 0.5), `min_score` (default 0.3), `project`, `tags`, `boost_recent` (default `false`) |
| `hybrid_search_similar` | Find similar notes via hybrid ranking | `path`, `top_k` (default 10), `alpha` (default 0.5), `min_score` (default 0.1), `project`, `tags` |

### Note Versioning Tools

Persistent version history for notes. Every `write_note` and `append_note` operation automatically saves a version snapshot before modifying the file (unless `skip_version: true`). Versions are stored in `.versions/<note-path>/<timestamp>.md` with frontmatter metadata (timestamp, reason, content hash, size). Duplicate versions (same content hash) are automatically skipped.

| Tool | Description | Parameters |
|------|-------------|------------|
| `list_versions` | List all saved versions of a note | `path`, `limit` (optional, max 100) |
| `read_version` | Read content of a specific historical version | `path`, `timestamp` (from list_versions), `include_metadata` (default `true`) |
| `restore_version` | Restore a note to a previous version (saves current as new version first) | `path`, `timestamp` |
| `diff_versions` | Compare two versions with unified diff output | `path`, `from_timestamp`, `to_timestamp`, `context_lines` (default 3). Use `"latest"` for most recent. |
| `delete_version` | Soft-delete a specific version (moves to .trash/) | `path`, `timestamp` |

**Usage examples:**

```
# List version history for a note
list_versions(path: "projects/roadmap.md")

# Read a specific version
read_version(path: "projects/roadmap.md", timestamp: "2024-01-15T10:30:00.000Z")

# Compare two versions
diff_versions(path: "projects/roadmap.md", from_timestamp: "2024-01-14T...", to_timestamp: "latest")

# Restore to a previous version (current content is auto-saved)
restore_version(path: "projects/roadmap.md", timestamp: "2024-01-14T...")

# Write without saving a version (performance optimization)
write_note(path: "draft.md", content: "...", skip_version: true)
```

**Version storage format:**
```
.versions/
  projects/
    roadmap.md/
      2024-01-14T09-00-00.000Z.md
      2024-01-15T10-30-00.000Z.md
```

Each version file contains YAML frontmatter:
```yaml
---
timestamp: "2024-01-15T10:30:00.000Z"
source_path: "projects/roadmap.md"
reason: "write_note overwrite"
content_hash: "a1b2c3d4e5f67890"
size: 1234
---
<note content at that point in time>
```

Configuration: max 50 versions per note by default. Old versions are auto-pruned. The `.versions/` directory is excluded from `list_notes`, `search_notes`, and other discovery tools.

| `session_history` | View session mutation history | `limit` (default `10`), `sessionId` (optional) |
| `extract_callouts` | Extract Obsidian callouts from a note | `path` |
| `quill_write` | Write a typed memory with frontmatter metadata | `path`, `content`, `type`, `project`, `confidence`, `importance`, `entity`, `source_type`, `source_reference`, `tags`, `related`, `supersedes`, `allow_secrets` |
| `quill_record_decision` | Record a decision memory | `project`, `content`, `entity`, `source_type`, `source_reference`, `confidence`, `importance`, `tags` |
| `quill_record_lesson` | Record a lesson learned | `project`, `content`, `entity`, `source_type`, `source_reference`, `confidence`, `importance`, `tags` |
| `quill_record_discovery` | Record a discovery memory | `project`, `content`, `entity`, `source_type` (required), `source_reference`, `confidence`, `importance`, `tags` |
| `quill_retrieve` | Smart retrieval with BM25 ranking | `query`, `project`, `mode` (compact/standard/deep), `type`, `tags`, `limit` |
| `quill_recall` | Quick recall of top project memories | `project`, `limit` (default 10) |
| `quill_detect_conflicts` | Detect contradictory memories | `project`, `type` |
| `quill_resolve_conflict` | Resolve a conflict between memories | `memory_id_a`, `memory_id_b`, `action` (supersede/reject/manual_review), `keeper`, `reason`. Also supports `batch` mode for auto-resolving all conflicts. |
| `quill_checkpoint` | Create a context checkpoint | `project`, `label`, `objective`, `current_state`, `known_problems`, `next_actions` |
| `quill_restore` | Restore context from checkpoint | `project`, `mode` (compact/standard/deep), `label` |
| `quill_consolidate` | Consolidate memories (merge/promote/archive) | `project`, `action` (merge_duplicates/promote_important/archive_obsolete), `confirm` |
| `quill_audit` | Query the memory audit log | `memory_id`, `action`, `from`, `to`, `limit` (default 50) |
| `quill_session_start` | Start a memory-aware session | `project`, `objective` |
| `quill_session_end` | End the current session | `summary`, `next_actions` |

### Task Management Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `create_task` | Create a new task as a markdown checkbox | `description`, `note` (default `tasks.md`), `due_date`, `tags`, `priority`, `section` |
| `complete_task` | Mark a task complete or reopen it | `note`, `line` or `search`, `action` (complete/reopen) |
| `list_tasks` | List tasks with filtering | `status`, `project`, `tags`, `priority`, `due_before`, `due_after`, `has_due_date`, `sort`, `limit`, `offset` |
| `query_tasks` | Advanced task queries with combined filters | `query`, `status`, `project`, `tags`, `any_tag`, `priority`, `due_before`, `due_after`, `overdue`, `has_due_date`, `sort`, `limit`, `offset`, `summary` |

### Recurring Task Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `complete_recurring` | Complete a recurring task and auto-create next occurrence | `note`, `line` or `search` |
| `list_recurring` | List all recurring tasks with next due dates | `pattern_type`, `status_filter` (active/paused/overdue/all), `sort`, `limit`, `offset` |
| `skip_recurrence` | Skip one or more occurrences without completing | `task_id`, or `note`+`line`, or `search`; `count` (default 1, max 52) |
| `pause_recurrence` | Temporarily pause a recurring task | `task_id`, or `note`+`line`, or `search` |
| `resume_recurrence` | Resume a paused recurring task | `task_id`, or `note`+`line`, or `search` |

### Kanban Board Tools

Markdown-based Kanban boards for visual task management. Boards are stored as markdown files with H2 headings as columns and checkbox items as tasks. Boards are auto-discovered from the `boards/` directory or any file with `type: kanban` in frontmatter.

| Tool | Description | Parameters |
|------|-------------|------------|
| `create_board` | Create a new Kanban board with columns | `board_name`, `path` (default `boards/<slug>.md`), `columns` (default `[Todo, In Progress, Done]`), `description` |
| `list_boards` | List all Kanban boards in the vault | `include_stats` (default true) |
| `read_board` | Read full board state with columns and tasks | `path`, `compact` (default false) |
| `move_task` | Move a task between columns (drag-drop) | `path`, `task` (description search), `from_column`, `to_column`, `position` |
| `add_to_column` | Add a new task to a specific column | `path`, `column`, `description`, `completed`, `tags`, `priority`, `due_date`, `position` |
| `archive_column` | Archive all tasks from a column | `path`, `column`, `archive_name` (default "Archive"), `clear_after` (default true) |
| `rename_column` | Rename a column | `path`, `column`, `new_name` |
| `reorder_columns` | Change column order | `path`, `columns` (array of names in desired order) |

**Board file format:**

```markdown
---
type: kanban
columns: [Todo, In Progress, Review, Done]
created: 2026-10-17T00:00:00Z
updated: 2026-10-17T00:00:00Z
---
# Project Board

## Todo
- [ ] Design API schema
- [ ] Write unit tests

## In Progress
- [ ] Implement auth module 🏷️ urgent 📌 high

## Review
- [ ] Code review for PR #42

## Done
- [x] Set up project structure 📅 2026-10-15
```

**Task metadata** uses emoji markers (compatible with the task management system):
- `🏷️ tag1,tag2` — Tags
- `📌 high|medium|low` — Priority
- `📅 YYYY-MM-DD` — Due date

Column matching is case-insensitive across all tools. Task movement preserves all metadata.

### Memory Files Tools

Persistent structured memory files with typed frontmatter metadata. Memories are stored as markdown files in the `memories/` directory with rich metadata (type, status, confidence, project, tags) for AI agents to read/write structured knowledge across sessions.

| Tool | Description | Parameters |
|------|-------------|------------|
| `read_memory` | Read a specific memory by ID | `id` |
| `write_memory` | Create or update a structured memory | `type`, `project`, `content`, `id` (omit to create), `status`, `confidence`, `source_type`, `importance`, `entity`, `tags`, `related`, `supersedes` |
| `list_memories` | List memories with filtering | `project`, `type`, `status`, `entity`, `tags`, `min_confidence`, `max_confidence`, `sort`, `limit`, `offset` |
| `search_memories` | BM25 keyword search across memories | `query`, `project`, `type`, `min_confidence`, `limit`, `offset` |
| `delete_memory` | Soft-delete a memory (move to trash) | `id`, `dry_run` |
| `link_memories` | Create relationships between memories | `source_id`, `target_id`, `relationship` (related/supersedes) |

**Memory file format** — each memory is a markdown file with structured frontmatter:

```yaml
---
id: mem_01ARZMY7X51XK2JW9YPB5CVDGM
type: DECISION
status: ACTIVE
confidence: 0.9
project: my-project
created: 2026-10-17T00:00:00Z
updated: 2026-10-17T00:00:00Z
source_type: AGENT
importance: HIGH
entity: frontend-framework
related: [mem_id1, mem_id2]
tags: [react, architecture]
supersedes: mem_old_id
---

We chose React over Vue for the frontend because...
```

**Memory types:** FACT, PREFERENCE, REQUIREMENT, CONSTRAINT, DECISION, ARCHITECTURE, PROJECT_STATE, TASK_STATE, DISCOVERY, LESSON, ERROR, SOLUTION, INSTRUCTION, CONTEXT, RELATIONSHIP, SESSION

**Supersession:** When a memory is replaced by newer information, use `supersedes` to link them. The old memory is automatically set to `SUPERSEDED` status.

## Tech Stack

- **TypeScript** — type-safe implementation
- **@modelcontextprotocol/sdk** — MCP server SDK
- **Zod** — runtime input validation
- **dotenv** — `.env` file configuration support
- **vitest** — test framework (v4)
- **ESLint + Prettier** — linting and formatting

## License

MIT
