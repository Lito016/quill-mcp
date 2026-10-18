import { vectorStore } from "../utils/vector-store.js";
import { getEmbeddingsDir, listEmbeddingFiles } from "../utils/embeddings.js";
import { getVaultRoot } from "../utils/vault.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";

export const name = "embedding_status";
export const description = [
    "Show the current semantic search indexing status and statistics.",
    "Reports how many notes are indexed, vocabulary size, and cache state.",
    "Useful for understanding search readiness and cache health.",
].join(" ");

export const inputSchema = z.object({});

export async function handler(_args: Record<string, never>) {
    const status = vectorStore.getStatus();

    // Count total markdown files in vault
    const totalFiles = await countVaultFiles();

    // Check for cached embedding files
    const cachedFiles = await listEmbeddingFiles();

    // Try to read index metadata
    let indexMeta: { lastIndexed: string; totalFiles: number; totalChunks: number; vocabularySize: number } | null = null;
    try {
        const metaPath = join(getEmbeddingsDir(), "index.json");
        const raw = await readFile(metaPath, "utf-8");
        indexMeta = JSON.parse(raw);
    } catch {
        // No metadata file
    }

    const lines = [
        "Semantic Search Index Status:",
        `  Index built: ${status.isIndexed ? "Yes" : "No"}`,
        `  Vault markdown files: ${totalFiles}`,
        `  Indexed files: ${status.indexedFiles}`,
        `  Indexed chunks: ${status.indexedChunks}`,
        `  Vocabulary size: ${status.vocabularySize} terms`,
        `  Cached embedding files: ${cachedFiles.length}`,
        `  Last indexed: ${status.lastIndexed ?? "Never"}`,
    ];

    if (indexMeta) {
        lines.push("");
        lines.push("Index Metadata:");
        lines.push(`  Files at last index: ${indexMeta.totalFiles}`);
        lines.push(`  Chunks at last index: ${indexMeta.totalChunks}`);
        lines.push(`  Vocabulary at last index: ${indexMeta.vocabularySize}`);
    }

    // Coverage assessment
    if (totalFiles > 0 && status.indexedFiles < totalFiles) {
        lines.push("");
        lines.push(`Note: ${totalFiles - status.indexedFiles} file(s) not yet indexed. Run index_vault to update.`);
    }

    return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
    };
}

async function countVaultFiles(): Promise<number> {
    const { readdir, lstat } = await import("node:fs/promises");
    const SKIP_DIRS = new Set([".trash", ".versions", ".embeddings", ".quill-sessions", ".git", "node_modules"]);
    const root = getVaultRoot();
    let count = 0;

    async function walk(dir: string): Promise<void> {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (SKIP_DIRS.has(entry.name)) continue;
            const fullPath = `${dir}/${entry.name}`;
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

    await walk(root);
    return count;
}
