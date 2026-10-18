# 02 — Plan: search/index performance and quality increment

Implements `docs/01-define.md` scope (F1–F10). Order chosen so the verification
harness is green before the performance work lands, keeping every later receipt
unambiguous.

## WS-D — Harness repair (first; makes the baseline honest)

| Fix | File(s) |
|---|---|
| Test typo: write `evil-parent/new-file.md` (matches junction name) | `src/utils/vault.test.ts` |
| `assertParentWithinVault` message: append `(via symlink)` (true failure mode, matches test contract and `assertWithinVault` phrasing) | `src/utils/vault.ts` |
| Restore `scripts/check-fs-policy.mjs`: scans `src/**/*.ts` (excluding `*.test.ts`) for `node:fs` / `node:fs/promises` imports; files not in an explicit ALLOWLIST fail; prints `PASS: <n> files scanned` / `FAIL: <violations>`; exit 1 on violation. ALLOWLIST = the current non-test importer set (honest freeze of today's footprint) | `scripts/check-fs-policy.mjs` (new) |
| Restore `scripts/copy-templates.mjs`: copies `templates/` → `dist/templates/` when the source exists (for `generate-hive-canvas` TSX side-output); logs and exits 0 otherwise. Un-breaks `npm run build`/`prepare` | `scripts/copy-templates.mjs` (new) |

Receipt: `vitest run` → 0 failed; `npm run build` exit 0.

## WS-A — Mutation invalidation + precise re-index (F1, F2)

New `src/utils/index-invalidation.ts`:
- `markVaultChanged()` → `knowledgeIndex.markDirty()` + `searchIndex.markDirty()` (external-change catch-all).
- `invalidateVaultPath(relPath)` → both indexes' `invalidatePath(relPath)` (precise, no full dirty).

Hook: `safeWriteTarget()` and `safeDeleteTarget()` in `src/utils/vault.ts` call
`invalidateVaultPath(...)` with the normalized vault-relative path. This covers every
mutating user tool (write/create/delete/move/copy/append/batch/rename/restore/
frontmatter), since all route through these two helpers. Internal writers
(`safeInternalPath` users: sessions, checkpoints, audit log) live in `.quill-sessions`,
which the indexes skip — no hook needed. Note: benign ESM import cycle
(vault → index-invalidation → indexes → vault) — index modules only call vault
functions at request time, never at module evaluation; documented in the module header.

Both indexes gain:
- `pendingInvalidations: Set<string>` + `invalidatePath(rel)`.
- `ensureSynchronized()`: if `dirty || !initialized` → full `synchronize()` (unchanged
  fallback; watcher/hive keep working as today). Else if pending → process each path:
  `stat` → missing ⇒ remove doc; directory ⇒ reconcile subtree (walk, add changed,
  remove unseen); file changed ⇒ re-index; unchanged ⇒ no-op. Case-insensitive key
  resolution (Windows): maintain lowercase→actual key map per index so a differently
  cased write path re-indexes the existing document instead of duplicating it.
- `searchIndex.removeDoc`: iterate the removed doc's own tokens (O(doc terms)) instead
  of every inverted posting list (O(vocabulary)).

`src/tools/search-notes.ts`: drop the per-document `pathExists` in both handlers
(index is now synchronously invalidated on server-side mutation; external edits are
covered by the watcher per assumption A3). Keep the `.trash` skip.

## WS-B — Index build performance (F3, F4)

- `knowledgeIndex`: replace the unconditional `rebuildTermIndex()` with incremental
  `addToTermIndex(entry)` / `removeFromTermIndex(entry)`; full rebuild remains only on
  `reset()`/`refresh()` paths. `synchronize()`'s deletion loop removes terms per entry.
- Bounded-concurrency I/O (chunked `Promise.all`, width 16) for per-file `lstat`/`stat`/
  `readFile` in both `searchIndex.scanDir` and `knowledgeIndex.scan`; per-file try/catch
  preserved; recursion order-free (maps are keyed by path).

## WS-C — Query quality (F5, F6, F7, F10)

- `search-notes.ts`: BM25 computed once per document per query (cached in a Map), not
  once per matching line; path filter boundary-aware (`""` | exact | `prefix + "/"`).
- `knowledgeIndex.suggestCorrection(word)`: Levenshtein over term-index keys with
  length prefilter and `max(1, autoTolerance)` — mirrors `searchIndex.suggestCorrection`.
- `discover.ts`: zero results ⇒ JSON response gains `suggestion` (string | null).
- `search-by-name.ts`: handler serves from `knowledgeIndex.getEntries()` (skip-list and
  incremental sync inherited); glob via the exported `globToRegExp` from
  `search-files.ts` (anchored, basename matching preserved); `recursive=false` filters
  direct children only; output text format unchanged.

## WS-E — Tests and measurement (woven into WS-A/B/C)

- `src/utils/knowledge-index.test.ts` (new): incremental term index (new token
  discoverable after write; removed token gone after delete), precise invalidation
  (single-file change syncs without stale results), `suggestCorrection`, skip-list
  behavior.
- `src/utils/search-index.test.ts` (new): `invalidatePath` (delete → gone; edit →
  updated; unchanged → untouched), case-insensitive key resolution, removeDoc leaves
  no orphan inverted entries.
- `tools-full.test.ts`: `search_by_name` ignores `node_modules`; boundary path filter
  in `search_notes` (`path:"Projects"` must not match `ProjectsX/note.md`).
- `src/benchmarks/incremental-sync.ts` (new): 10k-note vault → build → mutate one file →
  `ensureSynchronized` timing; prints one JSON line. Feeds success criterion 4.

## Verification plan (phase gate)

1. `node_modules\.bin\tsc --noEmit` — clean.
2. `node_modules\.bin\vitest.cmd run` — 0 failed (receipt vs 4-failed baseline).
3. `node dist\benchmarks\knowledge-index.js` — cold build ≥30% faster at 10k; discover
   p95 ≤ 24.0ms.
4. `node dist\benchmarks\incremental-sync.js` — single-file resync ≪ full walk.
5. `node bench-search.mjs` — real-vault sanity (17 docs, candidate reduction intact).
6. `npm run build` and `npm run fs-policy` — exit 0.
7. PRIME engine verbs from `C:\Users\Admin\.qoder\plugins\custom\prime-method-1.0.0\`:
   `verify.mjs build <target>` and `verify.mjs tests <target>` receipts pasted verbatim;
   remaining verbs not applicable to a backend MCP change (browser/ui/canvas/video/
   tokens/design-conformance skipped with reasons in the final report).
8. Evidence snapshots saved under `prime/evidence/`.

## Risks and mitigations

- **Parallel scan error handling** → per-file try/catch kept; a failing file skips
  exactly like today.
- **Precise invalidation race with watcher** → dirty flag always wins; precise sync is
  an accelerator, never a bypass; full-walk fallback intact.
- **Windows case collisions** → lowercase key map; worst case degrades to a correct
  no-op re-index under the existing key.
- **ESM import cycle** → verified benign (no top-level vault calls in index modules);
  documented in `index-invalidation.ts`.
- **fs-policy allowlist drift** → script fails loudly on any new direct-fs importer,
  forcing a conscious allowlist decision.
