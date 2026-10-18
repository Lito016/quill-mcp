# 01 — Define: quill-mcp search/index performance and quality increment

Template chosen: **increment** (Define → Plan → Build → Verify → Handoff).
Why: existing, working codebase with a contained enhancement scope (search/indexing);
no greenfield Specify/Design phases needed, but the audit-driven scope requires Define
and Plan artifacts. Full template would add ceremony without new decisions.

## User need

User asked (verbatim intent): audit quill-mcp; "enhance this more if it need more…
im thinking about indexing for faster search but i dont know maybe search for better."
Interpretation: make vault search faster and better, using indexing where it helps,
deferring to audit evidence on what actually needs changing.

## Measured baseline (this machine, 2026-10-15)

Cold index build + discover lookup (`node dist/benchmarks/knowledge-index.js`, synthetic vault):

```
{"notes":100,"build_ms":113.88,"lookup_median_ms":0.222,"lookup_p95_ms":0.568}
{"notes":1000,"build_ms":908.96,"lookup_median_ms":4.062,"lookup_p95_ms":6.155}
{"notes":10000,"build_ms":9565.24,"lookup_median_ms":20.184,"lookup_p95_ms":23.999}
```

Real vault (`node bench-search.mjs`): 17 docs, 1,623 terms, build 36.70ms, candidate
reduction 76–100% via inverted index. Today's real-vault queries are sub-millisecond —
the risk is scaling and correctness, not current latency.

Test suite baseline (`vitest run`): **379 passed / 4 failed (383)**, 19/21 files green.
`npm run build` fails (missing `scripts/copy-templates.mjs`, pre-existing).

## Audit findings

**F1 — Mutations never invalidate the indexes (correctness).**
Only the 5s-poll watcher (`src/utils/watcher.ts:184`) and `hive-auto-regen` call
`markDirty()`. Every mutating tool (write, create, delete, move, batch, rename,
restore, frontmatter writes) leaves `searchIndex`/`knowledgeIndex` stale until the
next watcher poll. `search_notes` masks this with a per-document `pathExists` stat
(`src/tools/search-notes.ts:276`); the `knowledgeIndex`-based tools (discover,
search_files, search_by_tag, list_folder) have no guard at all and can return
deleted/moved files for up to one poll interval.

**F2 — `search_notes` pays O(documents) disk stats per query.**
The per-doc `await pathExists(...)` runs for every candidate on every search, in both
the content handler and `frontmatter_only`. At 10k docs with fuzzy/regex queries
(no inverted filtering) that is ~10k stats per call — measured class of cost: stat ≈
50–200µs on Windows → 0.5–2s per query. It exists only to compensate F1.

**F3 — `knowledgeIndex` rebuilds its entire term index on every synchronize.**
`rebuildTermIndex()` (`src/utils/knowledge-index.ts:154`) is O(all tokens in vault) and
runs on every sync — even when the fingerprint walk found zero changed files.
`searchIndex` already maintains its inverted index incrementally; `knowledgeIndex`
does not. This is the dominant CPU share of every post-mutation resync.

**F4 — Cold index build is sequential I/O.**
`scanDir`/`scan` await `lstat`+`stat`+`readFile` per file strictly sequentially
(`search-index.ts:184`, `knowledge-index.ts:373`). At 10k notes: 9.57s cold build.
Bounded-concurrency per-directory I/O is the standard fix.

**F5 — BM25 recomputed per matching line.**
`search-notes.ts:294` computes the same document-level score once per matching line
instead of once per document.

**F6 — Path filter is not boundary-aware.**
`doc.path.startsWith(path)` (`search-notes.ts:267`) makes `path:"Projects"` also match
`ProjectsX/note.md`. `knowledge-index.ts` has the correct `isWithinFolder`; the content
search does not reuse it.

**F7 — `search_by_name` walks the raw filesystem and has no skip-list.**
`src/tools/search-by-name.ts` does its own recursive readdir with no
node_modules/.git/.trash exclusion — searching from the root descends into
`node_modules` (slow, wrong) — while the knowledge index already tracks every filename.

**F8 — Two failing tests are test bugs, not product bugs.**
- `vault.test.ts:467` writes `evil_parent/new-file.md` (underscore) but the junction is
  `evil-parent` (hyphen): benign path, rejection never triggered. Typo in test.
- `vault.test.ts:233` expects message containing `"symlink"`, but
  `assertParentWithinVault` throws `"...resolves outside the vault."` (no "symlink").
  The control fired correctly; the diagnostic string is less specific than
  `assertWithinVault`'s. Isolated repro: control threw, message mismatched.

**F9 — Missing `scripts/` directory breaks the harness.**
`scripts/check-fs-policy.mjs` (referenced by `fs-policy.test.ts` and `npm run fs-policy`)
and `scripts/copy-templates.mjs` (referenced by `npm run build`/`prepare`) do not exist.
`generate-hive-canvas.ts:667` reads `dist/templates/hive-canvas-footer.tsx` — the copy
script's job — which is why the TSX side-skip is "template not found" today.

**F10 — No "did you mean" in `discover`.**
`search_notes` has `suggestCorrection`; `discover` returns an empty result with no
suggestion on typos, even though the term index to support it exists.

**Not defects / out of scope (recorded deliberately):**
- Two parallel indexes over the same vault (`searchIndex` .md full-text vs
  `knowledgeIndex` all-files). Unifying is a larger refactor; not this increment.
- No persistent on-disk index. A stdio server rebuilds per session; a disk cache
  reintroduces stale-cache failure modes this server previously suffered from.
  Revisit only if cold build stays painful after F4.
- `retrieval-engine.ts`/`metadata-index.ts` (quill memory system) — separate index
  over `.quill-sessions`, already incremental; untouched.

## Scope

In: F1–F10 as planned in `docs/02-plan.md`. No new MCP tools (rate-limiter/config
invariants untouched). No new runtime dependencies. No new top-level folder — the
codebase's existing `utils/`/`tools/` structure absorbs every change; a new folder is
not needed (user's "build a new folder if it needs upgrade" answered: it doesn't).

Out: index unification, persistent disk cache, vector/semantic search, tool surface
changes, vault content changes.

## Assumptions (risk-ordered)

- **A1**: "Indexing for faster search / search for better" means improving the existing
  MCP search tools' performance and result quality — not introducing embedding/semantic
  search. — Why safe: no embeddings infra exists in this zero-dependency stdio server,
  and the audit shows classical-index gaps are the measured bottleneck. — Falsified if:
  user asks for semantic/natural-language retrieval.
- **A2**: Zero new runtime dependencies (keep `@modelcontextprotocol/sdk`, `dotenv`,
  `zod` only). — Why safe: ecosystem standard (MiniSearch/FlexSearch) implements the
  same in-memory inverted-index pattern the codebase already has; the gaps are
  maintenance/invalidation, not the engine; smaller dependency surface for an MCP
  server is worth more than rewriting scoring semantics. — Falsified if: in-house
  fixes cannot meet the success criteria below.
- **A3**: Acceptable consistency model = server-made mutations are visible to the very
  next search (synchronous precise invalidation); externally-made edits (Obsidian user)
  may lag up to the watcher poll (5s). — Why safe: matches how the other discovery
  tools already behave and how the watcher was designed. — Falsified if: user requires
  strict read-after-write for external editor changes.
- **A4**: The 4 baseline test failures are harness defects (F8, F9), not product
  vulnerabilities. — Why safe: isolated repro shows the security control fires and the
  junction is created under the hyphenated name; fs-policy failures are a missing
  script file, not a policy breach. — Falsified if: fixing the test typo still fails.
- **A5**: Restoring `scripts/check-fs-policy.mjs` (AST guard printing PASS/FAIL over
  direct `node:fs` imports in `src/**/*.ts`, tests excluded) and
  `scripts/copy-templates.mjs` (copy `templates/` → `dist/templates/` when present)
  matches the original intent inferred from their call sites. — Why safe: contract is
  pinned by `fs-policy.test.ts` and the `generate-hive-canvas` template path. —
  Falsified if: restored script flags pre-existing files as violators under the
  intended policy (then the allowlist, not the design, was wrong).

## Success criteria (verifiable)

1. Test suite: 0 failed (from 4 failed), same or higher pass count; `tsc --noEmit` clean.
2. Cold build at 10k notes: ≥30% faster than 9,565ms baseline (target ≤6,700ms).
3. Discover lookup at 10k notes: p95 not worse than 24.0ms baseline (should improve).
4. Single-file mutation → next search: index sync touches O(changed) paths, not the
   whole vault (measured via targeted benchmark added in Build).
5. `search_notes` performs zero per-document stats during result collection.
6. `search_by_name` returns no results from `node_modules`/`.git`/`.trash` and does no
   raw recursive walk.
7. `discover` returns a suggestion on typo-only queries with zero results.
8. `npm run build` and `npm run fs-policy` succeed.
