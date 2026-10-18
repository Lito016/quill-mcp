import * as z from "zod";
import { DISCOVERY_FIELDS, knowledgeIndex, normalizeVaultRelativePath } from "../utils/knowledge-index.js";
import type { DiscoveryField, ResourceType } from "../utils/knowledge-index.js";
import { boundedLimit, decodeCursor, encodeCursor } from "../utils/pagination.js";

export const name = "discover";
export const description =
    "Discover vault resources across filenames, paths, YAML title/tags/aliases, headings, and content. Returns ranked concise metadata; use read_note for full content.";
export const inputSchema = z.object({
    query: z.string().min(1).describe("Knowledge or resource to find"),
    folder: z.string().default(".").describe("Optional folder restriction relative to the vault root"),
    limit: z.number().int().positive().max(200).default(20),
    cursor: z.string().optional().describe("Opaque continuation cursor returned by a previous call"),
    types: z.array(z.enum(["file", "folder"])).default(["file", "folder"]),
    search_fields: z.array(z.enum(DISCOVERY_FIELDS)).default([...DISCOVERY_FIELDS]),
});

export async function handler({
    query,
    folder = ".",
    limit = 20,
    cursor,
    types = ["file", "folder"],
    search_fields = [...DISCOVERY_FIELDS],
}: {
    query: string;
    folder?: string;
    limit?: number;
    cursor?: string;
    types?: ResourceType[];
    search_fields?: DiscoveryField[];
}) {
    const safeFolder = normalizeVaultRelativePath(folder);
    await knowledgeIndex.ensureSynchronized();
    const all = knowledgeIndex.discover(query, safeFolder, search_fields, types);
    const offset = decodeCursor(cursor);
    const take = boundedLimit(limit, 20);
    const results = all.slice(offset, offset + take);
    const nextOffset = offset + results.length;

    // On zero results, offer "did you mean" corrections token by token
    let suggestion: string | null = null;
    if (all.length === 0 && types.includes("file")) {
        const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
        const corrected = tokens.map((token) => knowledgeIndex.suggestCorrection(token) ?? token);
        if (corrected.some((c, i) => c !== tokens[i])) suggestion = corrected.join(" ");
    }

    return {
        content: [
            {
                type: "text" as const,
                text: JSON.stringify({
                    query,
                    count: results.length,
                    total: all.length,
                    results,
                    next_cursor: nextOffset < all.length ? encodeCursor(nextOffset) : null,
                    suggestion,
                }),
            },
        ],
    };
}
