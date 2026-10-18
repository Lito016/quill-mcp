import * as z from "zod";
import { ensureIndexInitialized } from "../utils/memory-ops.js";
import { metadataIndex } from "../utils/metadata-index.js";
import { MEMORY_TYPES, MEMORY_STATUSES } from "../utils/memory-schema.js";
import type { MemoryType, MemoryStatus } from "../utils/memory-schema.js";
import type { MemoryFilter } from "../utils/metadata-index.js";
import { MAX_PAGINATION_LIMIT } from "../utils/errors.js";

export const name = "list_memories";
export const description =
    "List all memory files with filtering by type, project, status, confidence, entity, and tags. " +
    "Returns a summary table of matching memories with their metadata. " +
    "Use read_memory to get full content of a specific memory.";

export const inputSchema = z.object({
    project: z.string().optional().describe("Filter by project name (case-insensitive)."),
    type: z
        .string()
        .optional()
        .describe("Filter by memory type. One of: " + MEMORY_TYPES.join(", ") + ". Supports comma-separated values."),
    status: z
        .string()
        .optional()
        .describe("Filter by status. One of: " + MEMORY_STATUSES.join(", ") + ". Supports comma-separated values."),
    entity: z.string().optional().describe("Filter by entity name (case-insensitive)."),
    tags: z.array(z.string()).optional().describe("Filter: memory must have at least one of these tags."),
    min_confidence: z.number().min(0).max(1).optional().describe("Minimum confidence score (0.0–1.0)."),
    max_confidence: z.number().min(0).max(1).optional().describe("Maximum confidence score (0.0–1.0)."),
    limit: z.number().max(MAX_PAGINATION_LIMIT).optional().describe("Maximum number of results."),
    offset: z.number().default(0).describe("Number of results to skip (for pagination)."),
    sort: z
        .enum(["updated_desc", "updated_asc", "created_desc", "created_asc", "confidence_desc", "type"])
        .default("updated_desc")
        .describe("Sort order for results."),
});

export async function handler({
    project,
    type,
    status,
    entity,
    tags,
    min_confidence,
    max_confidence,
    limit,
    offset,
    sort,
}: {
    project?: string;
    type?: string;
    status?: string;
    entity?: string;
    tags?: string[];
    min_confidence?: number;
    max_confidence?: number;
    limit?: number;
    offset: number;
    sort: string;
}) {
    await ensureIndexInitialized();

    // Build filter
    const filter: MemoryFilter = {};
    if (project) filter.project = project;
    if (type) {
        const types = type.split(",").map((t) => t.trim().toUpperCase()) as MemoryType[];
        filter.type = types.length === 1 ? types[0] : types;
    }
    if (status) {
        const statuses = status.split(",").map((s) => s.trim().toUpperCase()) as MemoryStatus[];
        filter.status = statuses.length === 1 ? statuses[0] : statuses;
    }
    if (entity) filter.entity = entity;
    if (tags && tags.length > 0) filter.tags = tags;
    if (min_confidence !== undefined) filter.minConfidence = min_confidence;
    if (max_confidence !== undefined) filter.maxConfidence = max_confidence;

    let results = metadataIndex.query(filter);

    // Sort
    sortResults(results, sort);

    // Paginate
    const total = results.length;
    const paginated = limit ? results.slice(offset, offset + limit) : results.slice(offset);

    if (paginated.length === 0) {
        return { content: [{ type: "text" as const, text: "No memories found matching the given filters." }] };
    }

    // Format output
    const lines: string[] = [];
    const isPaginated = limit !== undefined || offset > 0;
    if (isPaginated) {
        lines.push(`Showing ${paginated.length} of ${total} memories:`);
    } else {
        lines.push(`Found ${total} memories:`);
    }
    lines.push("");

    for (const mem of paginated) {
        const confidencePct = Math.round(mem.confidence * 100);
        const tagsStr = mem.tags.length > 0 ? ` [${mem.tags.join(", ")}]` : "";
        const entityStr = mem.entity ? ` (entity: ${mem.entity})` : "";
        lines.push(
            `${mem.id} | ${mem.type} | ${mem.status} | ${mem.project} | ${confidencePct}%${entityStr}${tagsStr}`,
        );
        if (mem.contentPreview) {
            lines.push(`  ${mem.contentPreview.slice(0, 120)}`);
        }
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

function sortResults(
    results: import("../utils/memory-schema.js").MemoryMetadata[],
    sort: string,
): void {
    switch (sort) {
        case "updated_asc":
            results.sort((a, b) => a.updated.localeCompare(b.updated));
            break;
        case "created_desc":
            results.sort((a, b) => b.created.localeCompare(a.created));
            break;
        case "created_asc":
            results.sort((a, b) => a.created.localeCompare(b.created));
            break;
        case "confidence_desc":
            results.sort((a, b) => b.confidence - a.confidence);
            break;
        case "type":
            results.sort((a, b) => a.type.localeCompare(b.type));
            break;
        default: // updated_desc
            results.sort((a, b) => b.updated.localeCompare(a.updated));
            break;
    }
}
