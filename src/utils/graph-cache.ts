/**
 * Cached vault graph to avoid re-scanning on every graph_neighborhood call.
 * Invalidated when vault files change (via watcher) or on explicit request.
 */
import { getVaultRoot } from "./vault.js";
import { scanVaultNotes, buildFullGraph } from "./graph.js";
import type { VaultGraph } from "./graph.js";

let cachedGraph: VaultGraph | null = null;
let cacheTimestamp = 0;
/** How long the graph cache stays valid (5 minutes) */
const CACHE_TTL_MS = 5 * 60_000;

/**
 * Get the vault graph, using cache if available and fresh.
 * Re-scans only if cache is missing or expired.
 */
export async function getCachedGraph(forceRefresh: boolean = false): Promise<VaultGraph> {
    const now = Date.now();

    if (!forceRefresh && cachedGraph && now - cacheTimestamp < CACHE_TTL_MS) {
        return cachedGraph;
    }

    const vaultRoot = getVaultRoot();
    const { nodes, edges } = await scanVaultNotes(vaultRoot);
    cachedGraph = buildFullGraph(nodes, edges, true);
    cacheTimestamp = now;

    return cachedGraph;
}

/**
 * Invalidate the cached graph. Call after vault mutations.
 */
export function invalidateGraphCache(): void {
    cachedGraph = null;
    cacheTimestamp = 0;
}

/**
 * Get cache status for diagnostics.
 */
export function getGraphCacheStatus(): { cached: boolean; ageMs: number; nodeCount: number; edgeCount: number } {
    return {
        cached: cachedGraph !== null,
        ageMs: cachedGraph ? Date.now() - cacheTimestamp : 0,
        nodeCount: cachedGraph?.nodes.length ?? 0,
        edgeCount: cachedGraph?.edges.length ?? 0,
    };
}
