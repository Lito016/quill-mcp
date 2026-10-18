import { resolveVaultPath, pathExists } from "../utils/vault.js";
import { hybridSearchSimilar } from "../utils/hybrid-search.js";
import * as z from "zod";

export const name = "hybrid_search_similar";
export const description = [
    "Find notes similar to a reference note using hybrid BM25 + semantic ranking.",
    "Combines keyword overlap (BM25 on reference terms) with conceptual similarity (TF-IDF cosine).",
    "Superior to pure semantic find-similar for discovering both topically and lexically related notes.",
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
    alpha: z
        .number()
        .min(0)
        .max(1)
        .default(0.5)
        .describe("BM25 vs semantic weight: 0 = pure semantic, 1 = pure BM25, 0.5 = balanced (default)."),
    min_score: z
        .number()
        .min(0)
        .max(1)
        .default(0.1)
        .describe("Minimum combined score threshold 0-1 (default: 0.1)."),
    project: z
        .string()
        .optional()
        .describe("Filter results to a specific project directory (vault-relative path)."),
    tags: z
        .array(z.string())
        .optional()
        .describe("Filter results to notes with specific tags."),
});

export async function handler({
    path,
    top_k,
    alpha,
    min_score,
    project,
    tags,
}: {
    path: string;
    top_k: number;
    alpha: number;
    min_score: number;
    project?: string;
    tags?: string[];
}) {
    // Verify the reference note exists
    const fullPath = resolveVaultPath(path);
    if (!(await pathExists(fullPath))) {
        return {
            content: [{ type: "text" as const, text: `Error: Note not found at "${path}".` }],
            isError: true,
        };
    }

    const results = await hybridSearchSimilar({
        path,
        top_k,
        alpha,
        min_score,
        project,
        tags,
    });

    if (results.length === 0) {
        return {
            content: [{ type: "text" as const, text: `No similar notes found for "${path}" with the current filters.` }],
        };
    }

    const lines = results.map((r, i) => {
        const combined = (r.score * 100).toFixed(1);
        const bm25 = (r.bm25_score * 100).toFixed(1);
        const sem = (r.semantic_score * 100).toFixed(1);
        const preview = r.preview.replace(/\n/g, " ").slice(0, 120);
        const tagStr = r.tags.length > 0 ? ` [${r.tags.join(", ")}]` : "";
        return `${i + 1}. [${combined}%] ${r.path}${tagStr}\n   BM25: ${bm25}% | Semantic: ${sem}%\n   ${preview}`;
    });

    const alphaLabel = alpha === 0 ? "pure semantic" : alpha === 1 ? "pure BM25" : `alpha=${alpha}`;
    const header = `Found ${results.length} note(s) similar to "${path}" [hybrid, ${alphaLabel}]:\n`;
    return {
        content: [{ type: "text" as const, text: header + lines.join("\n\n") }],
    };
}
