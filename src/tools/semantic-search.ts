import { resolveVaultPath, pathExists } from "../utils/vault.js";
import { vectorStore } from "../utils/vector-store.js";
import * as z from "zod";

export const name = "semantic_search";
export const description = [
    "Search notes by semantic similarity using TF-IDF vector embeddings.",
    "Finds notes conceptually related to the query, not just keyword matches.",
    "Returns ranked results with similarity scores and content previews.",
    "Supports filtering by project path and tags.",
].join(" ");

export const inputSchema = z.object({
    query: z
        .string()
        .min(1)
        .max(500)
        .describe("The search query. Describe what you're looking for conceptually."),
    top_k: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe("Maximum number of results to return (default: 10)."),
    min_similarity: z
        .number()
        .min(0)
        .max(1)
        .default(0.1)
        .describe("Minimum cosine similarity threshold (0-1, default: 0.1). Higher = more relevant."),
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
    query,
    top_k,
    min_similarity,
    project,
    tags,
}: {
    query: string;
    top_k: number;
    min_similarity: number;
    project?: string;
    tags?: string[];
}) {
    // Ensure the vector index is built
    await vectorStore.ensureIndexed();

    // Compute query vector
    const queryVector = vectorStore.computeQueryVector(query);

    if (queryVector.length === 0 || queryVector.every((v) => v === 0)) {
        return {
            content: [{ type: "text" as const, text: "Query produced no meaningful terms after stop-word removal." }],
        };
    }

    // Perform search
    let results = vectorStore.search(queryVector, top_k, min_similarity);

    // Apply project filter
    if (project) {
        const projectPrefix = project.replace(/\/+$/, "");
        results = results.filter(
            (r) => r.path === projectPrefix || r.path.startsWith(`${projectPrefix}/`),
        );
    }

    // Apply tag filter (requires reading frontmatter)
    if (tags && tags.length > 0) {
        results = await filterByTags(results, tags);
    }

    if (results.length === 0) {
        return {
            content: [{ type: "text" as const, text: `No semantically similar notes found for "${query}".` }],
        };
    }

    // Format output
    const lines = results.map((r, i) => {
        const score = (r.score * 100).toFixed(1);
        const chunkInfo = r.totalChunks > 1 ? ` (chunk ${r.chunkIndex + 1}/${r.totalChunks})` : "";
        const preview = r.preview.replace(/\n/g, " ").slice(0, 120);
        return `${i + 1}. [${score}%] ${r.path}${chunkInfo}\n   ${preview}`;
    });

    const header = `Found ${results.length} semantically similar note(s) for "${query}":\n`;
    return {
        content: [{ type: "text" as const, text: header + lines.join("\n\n") }],
    };
}

async function filterByTags(
    results: { path: string; chunkIndex: number; totalChunks: number; score: number; preview: string }[],
    tags: string[],
): Promise<typeof results> {
    const { readFile } = await import("node:fs/promises");
    const { parseFrontmatter } = await import("../utils/frontmatter.js");
    const filtered: typeof results = [];

    for (const result of results) {
        try {
            const fullPath = resolveVaultPath(result.path);
            const content = await readFile(fullPath, "utf-8");
            const { frontmatter } = parseFrontmatter(content);
            const noteTags = normalizeTags(frontmatter.tags);
            if (tags.every((t) => noteTags.includes(t.toLowerCase()))) {
                filtered.push(result);
            }
        } catch {
            // Skip files that can't be read
        }
    }

    return filtered;
}

function normalizeTags(raw: unknown): string[] {
    if (!raw) return [];
    const items = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
    return items
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim().replace(/^#/, "").toLowerCase())
        .filter(Boolean);
}
