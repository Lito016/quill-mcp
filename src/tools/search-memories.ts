import * as z from "zod";
import { ensureIndexInitialized } from "../utils/memory-ops.js";
import { metadataIndex } from "../utils/metadata-index.js";
import { computeBm25Score } from "../utils/retrieval-engine.js";
import { getConfig } from "../utils/config.js";
import { MAX_PAGINATION_LIMIT } from "../utils/errors.js";

export const name = "search_memories";
export const description =
    "Search across memory content and metadata using BM25 keyword ranking. " +
    "Searches both the body text and frontmatter fields (type, project, tags, entity). " +
    "Returns ranked results with content previews and relevance scores.";

export const inputSchema = z.object({
    query: z.string().min(1).describe("Search query text. Matched against memory content and metadata."),
    project: z.string().optional().describe("Restrict search to a specific project."),
    type: z.string().optional().describe("Restrict search to a memory type (e.g. DECISION, LESSON)."),
    limit: z.number().max(MAX_PAGINATION_LIMIT).optional().describe("Maximum number of results."),
    offset: z.number().default(0).describe("Number of results to skip (for pagination)."),
    min_confidence: z.number().min(0).max(1).optional().describe("Minimum confidence threshold."),
});

export async function handler({
    query,
    project,
    type,
    limit,
    offset,
    min_confidence,
}: {
    query: string;
    project?: string;
    type?: string;
    limit?: number;
    offset: number;
    min_confidence?: number;
}) {
    await ensureIndexInitialized();

    // Build filter
    const filter: import("../utils/metadata-index.js").MemoryFilter = {};
    if (project) filter.project = project;
    if (type) filter.type = type.toUpperCase() as import("../utils/memory-schema.js").MemoryType;
    if (min_confidence !== undefined) filter.minConfidence = min_confidence;

    const candidates = metadataIndex.query(filter);

    // Tokenize query
    const queryTokens = query
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 1);

    if (queryTokens.length === 0) {
        return { content: [{ type: "text" as const, text: "No valid search terms in query." }] };
    }

    const config = getConfig();
    const invertedIndex = metadataIndex.getInvertedIndex();

    // Score each candidate
    const scored = candidates
        .map((mem) => {
            const bm25 = computeBm25Score(
                mem.id,
                queryTokens,
                invertedIndex,
                config.ranking.bm25.k1,
                config.ranking.bm25.b,
            );

            // Also check if query matches metadata fields directly
            let metadataBoost = 0;
            const queryLower = query.toLowerCase();
            if (mem.tags.some((t) => t.toLowerCase().includes(queryLower))) metadataBoost += 2;
            if (mem.entity?.toLowerCase().includes(queryLower)) metadataBoost += 2;
            if (mem.project.toLowerCase().includes(queryLower)) metadataBoost += 1;
            if (mem.type.toLowerCase().includes(queryLower)) metadataBoost += 1;

            return { memory: mem, score: bm25 + metadataBoost };
        })
        .filter((r) => r.score > 0);

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    const total = scored.length;
    const paginated = limit ? scored.slice(offset, offset + limit) : scored.slice(offset);

    if (paginated.length === 0) {
        return { content: [{ type: "text" as const, text: `No memories found for "${query}".` }] };
    }

    // Format output
    const lines: string[] = [];
    const isPaginated = limit !== undefined || offset > 0;
    if (isPaginated) {
        lines.push(`Showing ${paginated.length} of ${total} results for "${query}":`);
    } else {
        lines.push(`Found ${total} memories for "${query}":`);
    }
    lines.push("");

    for (const { memory: mem, score } of paginated) {
        const confidencePct = Math.round(mem.confidence * 100);
        lines.push(`${mem.id} | ${mem.type} | ${mem.project} | ${confidencePct}% | score: ${score.toFixed(2)}`);
        if (mem.contentPreview) {
            lines.push(`  ${mem.contentPreview.slice(0, 150)}`);
        }
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}
