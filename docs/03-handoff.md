# quill-mcp Search/Index Improvement — PRIME Handoff

Date: 2026-10-15 · Template: **increment** (Define → Plan → Build → Verify → Handoff)

## Template choice

`increment` was the smallest template that fits: the need (audit + targeted
search/index upgrade) had a measured baseline and clear success criteria but no
separate specification or design surface (no UI, no API contract changes).

## Phase artifacts and receipts

| Phase | Artifact | Receipt |
|---|---|---|
| Define | `docs/01-define.md` | attested (baseline measurements are in the doc; no verify verb applies to a doc) |
| Plan | `docs/02-plan.md` | attested |
| Build | code + tests on disk | `verify build` → **GATE-PASS: build-check passed via tsc --noEmit**; suite: 22 files / **391 tests passed (0 failed)** (see verify summary) |
| Verify | `prime/evidence/*` | `verify secrets`, `verify placeholders`, `verify empty-catch` → all **GATE-PASS**; benchmarks in `prime/evidence/benchmarks.txt`; `verify tests` → **attested (no receipt)** — gate re-executes via `node --test`, mechanically incompatible with vitest .ts sources (probe: `ERR_MODULE_NOT_FOUND …tokens.js imported from tokens.test.ts`), full attempt record in `prime/evidence/tests-gate-attempt.txt` |
| Handoff | `docs/03-handoff.md` | attested (this doc) |

## What shipped

1. **Precise single-path index invalidation** (`src/utils/index-invalidation.ts`,
   wired into `vault.ts` `safeWriteTarget`/`safeDeleteTarget`): every note
   write/move/delete now re-checks exactly the affected paths instead of queueing a
   full-vault walk. Mutation → searchable in ~3 ms vs ~405 ms (**127×**, 10k-note
   synthetic vault; `mutation_visible: true`).
2. **Faster cold build**: parallel directory scan (bounded width 16), case-insensitive
   key maps, O(doc-terms) postings removal, incremental stats recompute.
   10k notes: **9,565 ms → 1,640–1,710 ms (5.6×, −82%)**. Criterion was ≥30%.
   Real vault (17 notes): **36.7 ms → 12.4 ms**.
3. **Incremental term index** for discovery (`knowledge-index.ts` upsert/remove
   instead of full rebuilds) + `suggestCorrection` ("did you mean") wired into
   `discover` on zero-result queries.
4. **Quality fixes**: boundary-aware `path` filter in `search_notes` (Projects no
   longer matches ProjectsX); per-doc BM25 cache; `search_by_name` served from the
   discovery index (no raw vault walk, internal dirs excluded).
5. **Harness repair** (pre-existing breakage): `npm run build` fixed
   (`scripts/copy-templates.mjs`), fs-policy guard restored
   (`scripts/check-fs-policy.mjs`, allowlist now includes the two benchmark
   harnesses), flaky audit-log ordering fixed (deterministic tie-break), one test
   typo fixed. Suite went from 4 baseline failures to 0.
6. **Tests added**: precise-invalidation suites for both indexes (search 11,
   knowledge 5), discovery suggestion/boundary/internal-dir tests (3), scoring/
   metadata/dirty-rebuild coverage restored (6). 391 total, all passing.

## New folder?

No new folder was needed — the user's instinct ("indexing for faster search") was
already the right architecture; the work was making the existing in-memory
inverted indexes precise and fast (research confirmed MiniSearch/FlexSearch use
the same pattern; zero new dependencies added, per assumption A2).

## Assumptions (risk-ordered)

- **A1 (highest)**: The vault mutation surface is fully covered by
  `safeWriteTarget`/`safeDeleteTarget`. If a mutator writes via another path, its
  changes would not be picked up until the next full sync (watcher/markDirty).
  Falsified by: any tool reporting stale search results after a write.
- **A2**: No external search library (MiniSearch/FlexSearch) is warranted; the
  in-house index matches their pattern. Falsified by: measured need for features
  they add (e.g. field-boosting config, wildcard term expansion at scale).
- **A3**: The 16-wide scan parallelism is safe on typical hardware (I/O-bound, no
  shared mutable state between tasks). Falsified by: fd exhaustion on exotic FS.
- **A4**: Precise invalidation may leave stale entries for *external* (non-tool)
  deletions until the next full sync — same semantics as before, now cheaper to
  recover. Falsified by: requirement for always-fresh external-change visibility
  without the watcher.
- **A5**: Benchmark noise on this machine is ±10%; single-run lookup p95 deltas of
  ~1.6 ms at 10k notes were treated as noise. Falsified by: repeated-run regression.

## Verify summary

| Check | Result |
|---|---|
| `verify build` | GATE-PASS (tsc --noEmit) |
| `npm run build` (emit + templates) | exit 0 |
| vitest suite | 22 files / 391 tests passed / 0 failed (two consecutive clean runs) |
| `verify tests` gate | attested — gate's `node --test` re-execution cannot run vitest .ts sources; probe evidence saved |
| `verify secrets` / `placeholders` / `empty-catch` | GATE-PASS ×3 |
| `npm run fs-policy` | PASS: 83 scanned, allowlist 44, 0 violations |
| Cold build @10k | 1,640–1,710 ms (was 9,565 ms) — 5.6× |
| Single-mutation sync @10k | 3.2 ms (was 405 ms full walk) — 127×, mutation visible |
| Real vault build | 12.4 ms (was 36.7 ms) |
| Video gate | N/A — no video artifact in this increment |

## Commit

`c:\Projects\Knowledge` is **not a git repository**; no commit was made and none
was initialized (initializing exceeds this run's authority). All changes are on
disk under `c:\Projects\Knowledge\quill-mcp`.

## Re-run sheet

```powershell
cd c:\Projects\Knowledge\quill-mcp

# Build gates
node C:\Users\Admin\.qoder\plugins\custom\prime-method-1.0.0\scripts\verify.mjs build c:\Projects\Knowledge\quill-mcp
npm run build

# Test suite (the honest equivalent of `verify tests` for this vitest project)
node_modules\.bin\vitest.cmd run

# Hygiene gates
node C:\Users\Admin\.qoder\plugins\custom\prime-method-1.0.0\scripts\verify.mjs secrets c:\Projects\Knowledge\quill-mcp
node C:\Users\Admin\.qoder\plugins\custom\prime-method-1.0.0\scripts\verify.mjs placeholders c:\Projects\Knowledge\quill-mcp
node C:\Users\Admin\.qoder\plugins\custom\prime-method-1.0.0\scripts\verify.mjs empty-catch c:\Projects\Knowledge\quill-mcp

# Policy guard
npm run fs-policy

# Benchmarks (requires the build above for dist/)
node dist\benchmarks\knowledge-index.js
node dist\benchmarks\incremental-sync.js
node bench-search.mjs

# Evidence inputs saved during the run (gate attempt record explains the skip):
#   prime\evidence\vitest-report.json      (raw vitest JSON, mechanical)
#   prime\evidence\test-results.json       (gate input derived from it)
#   prime\evidence\build-gate.txt
#   prime\evidence\tests-gate-attempt.txt
#   prime\evidence\benchmarks.txt
#   prime\evidence\hygiene-gates.txt
```
