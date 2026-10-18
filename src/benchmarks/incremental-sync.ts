import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { initVault } from "../utils/vault.js";
import { knowledgeIndex } from "../utils/knowledge-index.js";
import { searchIndex } from "../utils/search-index.js";
import { invalidateVaultPath } from "../utils/index-invalidation.js";

const sizes = process.argv
    .slice(2)
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0);
const benchmarkSizes = sizes.length ? sizes : [10_000];
delete process.argv[2];

for (const size of benchmarkSizes) {
    const root = await mkdtemp(join(tmpdir(), `quill-incremental-${size}-`));
    try {
        const folder = join(root, "notes");
        await mkdir(folder, { recursive: true });
        for (let start = 0; start < size; start += 250) {
            await Promise.all(
                Array.from({ length: Math.min(250, size - start) }, (_, offset) => {
                    const id = start + offset;
                    return writeFile(
                        join(folder, `note-${id}.md`),
                        `---\ntitle: Note ${id}\ntags: [general]\n---\n# Heading ${id}\nKnowledge body ${id}.`,
                        "utf-8",
                    );
                }),
            );
        }
        process.env.NOTES_VAULT_PATH = root;
        initVault();
        knowledgeIndex.reset();
        searchIndex.markDirty();

        const buildStart = performance.now();
        await Promise.all([knowledgeIndex.ensureSynchronized(), searchIndex.ensureSynchronized()]);
        const buildMs = performance.now() - buildStart;

        // Server-side mutation of one file, scheduled exactly as the
        // safeWriteTarget hook in utils/vault.ts schedules it
        await writeFile(
            join(folder, "note-0.md"),
            `---\ntitle: Note 0\ntags: [general]\n---\nMutation brandnewtoken ${Date.now()}.`,
            "utf-8",
        );
        invalidateVaultPath("notes/note-0.md");

        const preciseStart = performance.now();
        await Promise.all([knowledgeIndex.ensureSynchronized(), searchIndex.ensureSynchronized()]);
        const preciseMs = performance.now() - preciseStart;

        // Full dirty resync for comparison (the cost of any untracked change)
        knowledgeIndex.markDirty();
        searchIndex.markDirty();
        const fullStart = performance.now();
        await Promise.all([knowledgeIndex.ensureSynchronized(), searchIndex.ensureSynchronized()]);
        const fullMs = performance.now() - fullStart;

        const hits = knowledgeIndex.discover("brandnewtoken", ".", ["content"], ["file"]);
        console.log(
            JSON.stringify({
                notes: size,
                build_ms: Number(buildMs.toFixed(2)),
                precise_resync_ms: Number(preciseMs.toFixed(3)),
                full_resync_ms: Number(fullMs.toFixed(2)),
                mutation_visible: hits.some((hit) => hit.path === "notes/note-0.md"),
            }),
        );
    } finally {
        knowledgeIndex.reset();
        await rm(root, { recursive: true, force: true });
    }
}
