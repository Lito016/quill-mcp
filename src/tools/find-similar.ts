import { resolveVaultPath, pathExists } from "../utils/vault.js";
import { vectorStore } from "../utils/vector-store.js";
import * as z from "zod";

export const name = "find_similar";
export const description = [
    "Find notes that are semantically similar to a specific note.",
    "Uses TF-IDF vector embeddings to discover conceptually related content.",
    "Useful for finding related notes, building connections, and discovering overlooked links.",
].join(" ");

export const inputSchema = z.object({
    path: z
        .string()
        .describe("Vault-relative path to the reference note."),
    top_k: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe("Maximum number of similar notes to return (default: 10)."),
    min_similarity: z
        .number()
        .min(0)
        .max(1)
        .default(0.1)
        .describe("Minimum cosine similarity threshold (0-1, default: 0.1)."),
});

export async function handler({
    path,
    top_k,
    min_similarity,
}: {
    path: string;
    top_k: number;
    min_similarity: number;
}) {
    // Verify the file exists
    const fullPath = resolveVaultPath(path);
    if (!(await pathExists(fullPath))) {
        return {
            content: [{ type: "text" as const, text: `Error: Note not found at "${path}".` }],
            isError: true,
        };
    }

    // Ensure the vector index is built
    await vectorStore.ensureIndexed();

    // Check if the note is indexed
    if (!vectorStore.isIndexed(path)) {
        // Index it on the fly
        const { readFile } = await import("node:fs/promises");
        const content = await readFile(fullPath, "utf-8");
        await vectorStore.addDocument(path, content);
    }

    // Find similar notes
    const results = vectorStore.findSimilar(path, top_k, min_similarity);

    if (results.length === 0) {
        return {
            content: [{ type: "text" as const, text: `No similar notes found for "${path}".` }],
        };
    }

    // Format output
    const lines = results.map((r, i) => {
        const score = (r.score * 100).toFixed(1);
        const chunkInfo = r.totalChunks > 1 ? ` (chunk ${r.chunkIndex + 1}/${r.totalChunks})` : "";
        const preview = r.preview.replace(/\n/g, " ").slice(0, 120);
        return `${i + 1}. [${score}%] ${r.path}${chunkInfo}\n   ${preview}`;
    });

    const header = `Found ${results.length} note(s) similar to "${path}":\n`;
    return {
        content: [{ type: "text" as const, text: header + lines.join("\n\n") }],
    };
}
