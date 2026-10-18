import { vectorStore } from "../utils/vector-store.js";
import * as z from "zod";

export const name = "index_vault";
export const description = [
    "Manually trigger a full vault indexing for semantic search.",
    "Recomputes TF-IDF vector embeddings for all notes in the vault.",
    "Useful after adding many new notes or when search results seem stale.",
    "Indexing runs asynchronously and may take time for large vaults.",
].join(" ");

export const inputSchema = z.object({
    force: z
        .boolean()
        .default(false)
        .describe("Force rebuild even if index already exists (default: false)."),
});

export async function handler({ force }: { force: boolean }) {
    const startTime = Date.now();

    if (force) {
        // Clear existing cache before rebuild
        const { clearEmbeddingCache } = await import("../utils/embeddings.js");
        const cleared = await clearEmbeddingCache();
        if (cleared > 0) {
            // Log but continue
        }
    }

    await vectorStore.rebuild();

    const status = vectorStore.getStatus();
    const elapsed = Date.now() - startTime;

    // Count total files in vault for status
    const { readdir, lstat } = await import("node:fs/promises");
    const { getVaultRoot } = await import("../utils/vault.js");
    const totalFiles = await countMarkdownFiles(getVaultRoot());

    const lines = [
        "Vault indexing complete.",
        `  Files scanned: ${totalFiles}`,
        `  Files indexed: ${status.indexedFiles}`,
        `  Chunks indexed: ${status.indexedChunks}`,
        `  Vocabulary size: ${status.vocabularySize}`,
        `  Time elapsed: ${elapsed}ms`,
        `  Last indexed: ${status.lastIndexed}`,
    ];

    return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
    };
}

async function countMarkdownFiles(dir: string): Promise<number> {
    const { readdir, lstat } = await import("node:fs/promises");
    const SKIP_DIRS = new Set([".trash", ".versions", ".embeddings", ".quill-sessions", ".git", "node_modules"]);
    let count = 0;

    async function walk(currentDir: string): Promise<void> {
        let entries;
        try {
            entries = await readdir(currentDir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (SKIP_DIRS.has(entry.name)) continue;
            const fullPath = `${currentDir}/${entry.name}`;
            try {
                const s = await lstat(fullPath);
                if (s.isSymbolicLink()) continue;
                if (s.isDirectory()) {
                    await walk(fullPath);
                } else if (s.isFile() && entry.name.endsWith(".md")) {
                    count++;
                }
            } catch {
                // Skip
            }
        }
    }

    await walk(dir);
    return count;
}
