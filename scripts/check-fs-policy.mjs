#!/usr/bin/env node
/**
 * Filesystem-operation policy guard.
 *
 * Scans every .ts file under src/ (excluding *.test.ts) and flags any file
 * that references node:fs or node:fs/promises without being explicitly
 * allowlisted below. The allowlist is the deliberate footprint of direct
 * filesystem access; a new importer must be added here consciously, which is
 * exactly the review this guard exists to force.
 *
 * Output contract: prints a line starting with PASS or FAIL; exit 0 on pass,
 * exit 1 on any violation (asserted by src/tools/fs-policy.test.ts).
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");

/** Vault-relative (forward-slash) paths allowed to touch node:fs directly. */
const ALLOWLIST = new Set([
    // Central path-safety funnel and configuration loading
    "src/utils/vault.ts",
    "src/utils/config.ts",
    // Main entry point (reads vault.config.json for HTTP config resolution)
    "src/index.ts",
    // Frontmatter partial reader (reads file header for fast metadata extraction)
    "src/utils/frontmatter.ts",
    // Indexes and watchers (vault tree scans)
    "src/utils/search-index.ts",
    "src/utils/knowledge-index.ts",
    "src/utils/metadata-index.ts",
    "src/utils/watcher.ts",
    // Internal state writers (live under .quill-sessions / logs)
    "src/utils/audit-log.ts",
    "src/utils/session-tracker.ts",
    "src/utils/checkpoint.ts",
    "src/utils/trash.ts",
    // Version store (reads/writes version files under .versions/)
    "src/utils/version-store.ts",
    // Memory file CRUD (reads/writes memory files in memories/ directory)
    "src/utils/memory-ops.ts",
    // Discovery tools with dedicated read-only walks
    "src/tools/list-notes.ts",
    "src/tools/search-by-name.ts",
    "src/tools/find-backlinks.ts",
    "src/tools/extract-links.ts",
    "src/tools/extract-tags.ts",
    "src/tools/extract-callouts.ts",
    "src/tools/frontmatter.ts",
    "src/tools/health-check.ts",
    "src/tools/vault-guide.ts",
    "src/tools/generate-hive-canvas.ts",
    "src/tools/graph-neighborhood.ts", // Graph-aware retrieval (reads note content)
    "src/tools/note-sections.ts", // Section navigation (reads/writes note content)
    "src/tools/vault-health-audit.ts", // Vault health auditing (reads all notes)
    "src/tools/note-undo.ts", // Undo/redo (reads/writes note content)
    "src/tools/batch-read.ts", // Batch read (reads multiple notes)
    "src/tools/preview-changes.ts", // Change plan preview (reads files for hashing)
    "src/tools/apply-change-plan.ts", // Change plan apply (writes/moves/deletes files)
    "src/tools/restore-version.ts", // Version restore (reads versions, writes notes)
    "src/utils/change-plan.ts", // Change plan system (reads files for content hashing)
    // Task management tools (read/write markdown checkboxes)
    "src/tools/create-task.ts",
    "src/tools/complete-task.ts",
    "src/utils/task-index.ts", // Task index (scans vault for tasks)
    // Kanban board tools (read/write board files)
    "src/tools/create-board.ts",
    "src/tools/read-board.ts",
    "src/tools/list-boards.ts",
    "src/tools/add-to-column.ts",
    "src/tools/archive-column.ts",
    "src/tools/rename-column.ts",
    "src/tools/reorder-columns.ts",
    "src/utils/kanban-index.ts",
    // Recurring task engine
    "src/tools/complete-recurring.ts",
    "src/tools/move-task.ts",
    "src/utils/recurring-engine.ts",
    // Webhook manager
    "src/utils/webhook-manager.ts",
    // Mutation tools (all safety-gated via utils/vault.ts helpers)
    "src/tools/write-note.ts",
    "src/tools/create-note.ts",
    "src/tools/append-note.ts",
    "src/tools/batch-delete.ts",
    "src/tools/batch-move.ts",
    "src/tools/copy-note.ts",
    "src/tools/move-note.ts",
    "src/tools/delete-note.ts",
    "src/tools/delete-folder.ts",
    "src/tools/create-folder.ts",
    "src/tools/rename-folder.ts",
    "src/tools/create-template.ts",
    // Read/frontmatter/status tools
    "src/tools/read-note.ts",
    "src/tools/read-frontmatter.ts",
    "src/tools/write-frontmatter.ts",
    "src/tools/update-frontmatter.ts",
    "src/tools/vault-status.ts",
    // Memory-writing quill tools (record targets live under .quill-sessions)
    "src/tools/quill-write.ts",
    "src/tools/quill-record-decision.ts",
    "src/tools/quill-record-lesson.ts",
    "src/tools/quill-record-discovery.ts",
    // Graph traversal reads and benchmark harness
    "src/utils/graph.ts",
    "src/benchmarks/knowledge-index.ts",
    "src/benchmarks/incremental-sync.ts",
    "src/benchmarks/io-perf.ts", // I/O performance benchmark (reads, writes, cache)
    // Semantic search (TF-IDF embeddings, vector store, search tools)
    "src/utils/embeddings.ts",
    "src/utils/vector-store.ts",
    "src/tools/semantic-search.ts",
    "src/tools/find-similar.ts",
    "src/tools/index-vault.ts",
    "src/tools/embedding-status.ts",
]);

const FS_MODULE_RE = /["']node:fs(?:\/promises)?["']/;

async function collectTsFiles(dir, out = []) {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            await collectTsFiles(full, out);
        } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
            out.push(full);
        }
    }
    return out;
}

const files = await collectTsFiles(srcDir);
const violations = [];

for (const file of files) {
    let content;
    try {
        content = await readFile(file, "utf-8");
    } catch {
        continue;
    }
    if (!FS_MODULE_RE.test(content)) continue;
    const rel = relative(root, file).replace(/\\/g, "/");
    if (!ALLOWLIST.has(rel)) violations.push(rel);
}

if (violations.length > 0) {
    console.error(`FAIL: direct node:fs access outside the allowlist (${violations.length} file(s)):`);
    for (const v of violations) console.error(`  - ${v}`);
    console.error("Add the file to ALLOWLIST in scripts/check-fs-policy.mjs only after reviewing why it needs direct fs access.");
    process.exit(1);
}

console.log(`PASS: ${files.length} file(s) scanned, allowlist ${ALLOWLIST.size} file(s), 0 violations`);
