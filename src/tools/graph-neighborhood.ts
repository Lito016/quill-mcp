import { readFile } from "node:fs/promises";
import { resolveVaultPath, pathExists, getVaultRoot } from "../utils/vault.js";
import { getCachedGraph } from "../utils/graph-cache.js";
import { kHopNeighborhood, bfsShortestPath } from "../utils/graph.js";
import * as z from "zod";

export const name = "graph_neighborhood";
export const description =
    "Retrieve a note together with its connected neighborhood in a single call. " +
    "Returns backlinks, outgoing links, shared-tag neighbors, and optionally k-hop expansion. " +
    "Also supports shortest-path queries between two notes. " +
    "Use this instead of multiple read_note + find_backlinks calls to discover context efficiently.";

export const inputSchema = z.object({
    path: z
        .string()
        .describe("Path to the center note (relative to vault root, without .md extension)"),
    hops: z
        .number()
        .min(1)
        .max(3)
        .default(1)
        .describe("How many hops of neighborhood to traverse (1 = direct neighbors, 2 = neighbors-of-neighbors, max 3)"),
    include_content: z
        .boolean()
        .default(false)
        .describe("If true, include the full content of the center note and all neighbors"),
    include_content_center_only: z
        .boolean()
        .default(true)
        .describe("If true and include_content is true, only include content for the center note (not neighbors)"),
    include_inferred: z
        .boolean()
        .default(true)
        .describe("If true, include inferred edges (shared-tag connections) in the neighborhood"),
    shortest_path_to: z
        .string()
        .optional()
        .describe("If set, also compute the shortest path from the center note to this target note"),
});

export async function handler({
    path,
    hops,
    include_content,
    include_content_center_only,
    _include_inferred,
    shortest_path_to,
}: {
    path: string;
    hops: number;
    include_content: boolean;
    include_content_center_only: boolean;
    _include_inferred: boolean;
    shortest_path_to?: string;
}) {
    const vaultRoot = getVaultRoot();

    // Resolve the center note path
    const notePath = path.endsWith(".md") ? path : `${path}.md`;
    const fullPath = resolveVaultPath(notePath);

    if (!(await pathExists(fullPath))) {
        return {
            content: [{ type: "text" as const, text: `Error: Note not found at "${path}".` }],
            isError: true,
        };
    }

    // Get cached graph (avoids re-scanning vault on every call)
    const graph = await getCachedGraph();

    // Find the center node ID
    const centerId = path.replace(/\.md$/, "").replace(/\\/g, "/");
    const centerNode = graph.nodeMap.get(centerId);

    if (!centerNode) {
        return {
            content: [{ type: "text" as const, text: `Error: Note "${path}" not found in vault graph.` }],
            isError: true,
        };
    }

    // Compute neighborhood
    const neighborhood = kHopNeighborhood(graph, centerId, hops);

    // Build output
    const parts: string[] = [];

    // Center note info
    parts.push(`# Neighborhood: ${centerNode.path}`);
    parts.push(`Tags: ${centerNode.tags.length > 0 ? centerNode.tags.join(", ") : "(none)"}`);
    parts.push("");

    // Center note content
    if (include_content) {
        try {
            const content = await readFile(fullPath, "utf-8");
            parts.push(`## Content`);
            parts.push(content);
            parts.push("");
        } catch {
            parts.push(`## Content`);
            parts.push(`(unable to read file)`);
            parts.push("");
        }
    }

    // Stats
    parts.push(`## Neighborhood Stats`);
    parts.push(`Total neighbors: ${neighborhood.stats.totalNeighbors}`);
    parts.push(`  Backlinks: ${neighborhood.stats.backlinks}`);
    parts.push(`  Outgoing: ${neighborhood.stats.outgoing}`);
    parts.push(`  Shared-tag: ${neighborhood.stats.sharedTagNeighbors}`);
    parts.push(`  Max hops: ${neighborhood.stats.maxHop}`);
    parts.push("");

    // Group neighbors by connection type
    const backlinks = neighborhood.neighbors.filter((n) => n.connection.type === "backlink");
    const outgoing = neighborhood.neighbors.filter((n) => n.connection.type === "outgoing" && n.connection.hop === 1);
    const tagNeighbors = neighborhood.neighbors.filter((n) => n.connection.type === "shared-tags");
    const indirect = neighborhood.neighbors.filter((n) => n.connection.hop > 1);

    if (backlinks.length > 0) {
        parts.push(`## Backlinks (${backlinks.length})`);
        for (const n of backlinks.slice(0, 30)) {
            const tags = n.tags.length > 0 ? ` [${n.tags.join(", ")}]` : "";
            parts.push(`- ${n.path} (${n.connection.edgeType})${tags}`);
        }
        if (backlinks.length > 30) parts.push(`... and ${backlinks.length - 30} more`);
        parts.push("");
    }

    if (outgoing.length > 0) {
        parts.push(`## Outgoing Links (${outgoing.length})`);
        for (const n of outgoing.slice(0, 30)) {
            const tags = n.tags.length > 0 ? ` [${n.tags.join(", ")}]` : "";
            parts.push(`- ${n.path} (${n.connection.edgeType})${tags}`);
        }
        if (outgoing.length > 30) parts.push(`... and ${outgoing.length - 30} more`);
        parts.push("");
    }

    if (tagNeighbors.length > 0) {
        parts.push(`## Shared-Tag Neighbors (${tagNeighbors.length})`);
        for (const n of tagNeighbors) {
            const shared = n.connection.sharedTags?.join(", ") || "";
            parts.push(`- ${n.path} (shared: ${shared})`);
        }
        parts.push("");
    }

    if (indirect.length > 0) {
        parts.push(`## Indirect Neighbors (${indirect.length}, hop > 1)`);
        for (const n of indirect.slice(0, 20)) {
            parts.push(`- ${n.path} (hop ${n.connection.hop})`);
        }
        if (indirect.length > 20) parts.push(`... and ${indirect.length - 20} more`);
        parts.push("");
    }

    // Neighbor content (if requested and not center-only)
    if (include_content && !include_content_center_only) {
        parts.push(`## Neighbor Content`);
        for (const n of neighborhood.neighbors.slice(0, 20)) {
            // Cap at 20 to avoid overwhelming output
            const nFullPath = `${vaultRoot}/${n.path}`;
            try {
                const content = await readFile(nFullPath, "utf-8");
                parts.push(`### ${n.path}`);
                parts.push(content.slice(0, 500)); // First 500 chars
                if (content.length > 500) parts.push(`... (truncated)`);
                parts.push("");
            } catch {
                parts.push(`### ${n.path}`);
                parts.push(`(unable to read)`);
                parts.push("");
            }
        }
    }

    // Shortest path (if requested)
    if (shortest_path_to) {
        const targetId = shortest_path_to.replace(/\.md$/, "").replace(/\\/g, "/");
        const pathResult = bfsShortestPath(graph.adjacency, graph.edges, centerId, targetId, 5);

        parts.push(`## Shortest Path: ${centerId} → ${targetId}`);
        if (pathResult === null) {
            parts.push(`No path found (max 5 hops).`);
        } else if (pathResult.length === 0) {
            parts.push(`Same note.`);
        } else {
            parts.push(`Path length: ${pathResult.length} hop(s)`);
            for (const hop of pathResult) {
                parts.push(`  ${hop.from} → ${hop.to} (${hop.edgeType}, ${hop.confidence})`);
            }
        }
        parts.push("");
    }

    return { content: [{ type: "text" as const, text: parts.join("\n") }] };
}
