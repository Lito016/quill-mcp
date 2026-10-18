import { hybridSearch } from "../utils/hybrid-search.js";
import * as z from "zod";

export const name = "hybrid_search";
export const description = [
    "Search notes using hybrid ranking that combines BM25 full-text search with semantic TF-IDF similarity.",
    "Produces superior retrieval quality by leveraging both keyword matching and conceptual similarity.",
    "The alpha parameter controls the balance: 0 = pure semantic, 1 = pure BM25, 0.5 = balanced (default).",
    "Supports filtering by project path, tags, minimum score, and recency boosting.",
].join(" ");

export const inputSchema = z.object({
    query: z
        .string()
        .min(1)
        .max(500)
        .describe("The search query. Describe what you're looking for."),
    top_k: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe("Maximum number of results to return (default: 10)."),
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
        .default(0.3)
        .describe("Minimum combined score threshold 0-1 (default: 0.3). Higher = stricter relevance."),
    project: z
        .string()
        .optional()
        .describe("Filter results to a specific project directory (vault-relative path)."),
    tags: z
        .array(z.string())
        .optional()
        .describe("Filter results to notes with specific tags."),
    boost_recent: z
        .boolean()
        .default(false)
        .describe("If true, boost recently modified notes (exponential decay over 30 days)."),
});

export async function handler({
    query,
    top_k,
    alpha,
    min_score,
    project,
    tags,
    boost_recent,
}: {
    query: string;
    top_k: number;
    alpha: number;
    min_score: number;
    project?: string;
    tags?: string[];
    boost_recent: boolean;
}) {
    const results = await hybridSearch({
        query,
        top_k,
        alpha,
        min_score,
        project,
        tags,
        boost_recent,
    });

    if (results.length === 0) {
        return {
            content: [{ type: "text" as const, text: `No results found for "${query}" with the current filters.` }],
        };
    }

    const lines = results.map((r, i) => {
        const combined = (r.score * 100).toFixed(1);
        const bm25 = (r.bm25_score * 100).toFixed(1);
        const sem = (r.semantic_score * 100).toFixed(1);
        const preview = r.preview.replace(/\n/g, " ").slice(0, 120);
        const tagStr = r.tags.length > 0 ? ` [${r.tags.join(", ")}]` : "";
        const modified = r.modified ? ` (modified: ${r.modified.slice(0, 10)})` : "";
        return `${i + 1}. [${combined}%] ${r.path}${tagStr}${modified}\n   BM25: ${bm25}% | Semantic: ${sem}%\n   ${preview}`;
    });

    const alphaLabel = alpha === 0 ? "pure semantic" : alpha === 1 ? "pure BM25" : `alpha=${alpha}`;
    const header = `Found ${results.length} result(s) for "${query}" [hybrid, ${alphaLabel}]:\n`;
    return {
        content: [{ type: "text" as const, text: header + lines.join("\n\n") }],
    };
}
