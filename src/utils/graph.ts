import { readdir, readFile, lstat } from "node:fs/promises";
import { getVaultRoot } from "./vault.js";
import { extractLinks } from "./links.js";
import { extractTags } from "./frontmatter.js";

// --- Types ---

export interface VaultNode {
    id: string;
    path: string;
    tags: string[];
}

export interface VaultEdge {
    from: string;
    to: string;
    type: "wiki" | "markdown" | "shared-tags";
    confidence: "EXTRACTED" | "INFERRED";
    /** For shared-tags edges, the tags that connect these two nodes */
    sharedTags?: string[];
}

export interface VaultGraph {
    nodes: VaultNode[];
    edges: VaultEdge[];
    nodeMap: Map<string, VaultNode>;
    adjacency: Map<string, Set<string>>;
}

export interface CommunityResult {
    id: number;
    members: string[];
    internalEdges: number;
    dominantTags: { tag: string; count: number }[];
}

export interface CentralityResult {
    id: string;
    path: string;
    degree: number;
    inDegree: number;
    outDegree: number;
    centrality: number;
}

export interface PathHop {
    from: string;
    to: string;
    edgeType: "wiki" | "markdown" | "shared-tags";
    confidence: "EXTRACTED" | "INFERRED";
    sharedTags?: string[];
}

// --- Vault scanning ---

/**
 * Scan the vault (or a subdirectory) and return all nodes and explicit edges.
 * Skips .trash/ directory.
 */
export async function scanVaultNotes(
    dirPath: string,
): Promise<{ nodes: VaultNode[]; edges: VaultEdge[]; nodeMap: Map<string, VaultNode> }> {
    const nodes: VaultNode[] = [];
    const edges: VaultEdge[] = [];
    const nodeMap = new Map<string, VaultNode>();

    async function scanDir(dir: string) {
        const items = await readdir(dir, { withFileTypes: true });
        for (const item of items) {
            if (item.name === ".trash" || item.name === ".quill-sessions" || item.name === ".versions") continue;
            const fullPath = `${dir}/${item.name}`;
            // Symlink defense: never recurse into symbolic links
            const entryStat = await lstat(fullPath);
            if (entryStat.isSymbolicLink()) continue;
            if (item.isDirectory()) {
                await scanDir(fullPath);
            } else if (item.name.endsWith(".md")) {
                try {
                    const content = await readFile(fullPath, "utf-8");
                    const relPath = fullPath.startsWith(getVaultRoot())
                        ? fullPath.slice(getVaultRoot().length + 1)
                        : fullPath;

                    const nodeId = relPath.replace(/\.md$/, "").replace(/\\/g, "/");
                    const tags = extractTags(content);

                    const node: VaultNode = { id: nodeId, path: relPath, tags };
                    nodes.push(node);
                    nodeMap.set(nodeId, node);

                    const links = extractLinks(content);

                    for (const link of links.wiki) {
                        edges.push({ from: nodeId, to: link.target, type: "wiki", confidence: "EXTRACTED" });
                    }

                    for (const mdLink of links.markdown) {
                        const target = mdLink.target.replace(/\.md$/, "").replace(/#.*$/, "");
                        edges.push({ from: nodeId, to: target, type: "markdown", confidence: "EXTRACTED" });
                    }
                } catch {
                    // Skip unreadable files
                }
            }
        }
    }

    await scanDir(dirPath);
    return { nodes, edges, nodeMap };
}

// --- Graph building ---

/**
 * Build an adjacency list from nodes and edges (undirected).
 */
export function buildAdjacency(nodes: VaultNode[], edges: VaultEdge[]): Map<string, Set<string>> {
    const adj = new Map<string, Set<string>>();
    for (const node of nodes) {
        adj.set(node.id, new Set());
    }
    for (const edge of edges) {
        if (!adj.has(edge.from)) adj.set(edge.from, new Set());
        if (!adj.has(edge.to)) adj.set(edge.to, new Set());
        adj.get(edge.from)!.add(edge.to);
        adj.get(edge.to)!.add(edge.from);
    }
    return adj;
}

/**
 * Build inferred edges from shared tags.
 * Two nodes are connected if they share `minShared` or more tags (default: 2).
 */
export function buildTagEdges(nodes: VaultNode[], minShared: number = 2): VaultEdge[] {
    const tagEdges: VaultEdge[] = [];
    for (let i = 0; i < nodes.length; i++) {
        const tagsA = new Set(nodes[i].tags);
        for (let j = i + 1; j < nodes.length; j++) {
            const tagsB = new Set(nodes[j].tags);
            const shared = [...tagsA].filter((t) => tagsB.has(t));
            if (shared.length >= minShared) {
                tagEdges.push({
                    from: nodes[i].id,
                    to: nodes[j].id,
                    type: "shared-tags",
                    confidence: "INFERRED",
                    sharedTags: shared,
                });
            }
        }
    }
    return tagEdges;
}

/**
 * Build a full VaultGraph including optional inferred edges.
 */
export function buildFullGraph(
    nodes: VaultNode[],
    explicitEdges: VaultEdge[],
    includeInferred: boolean = true,
): VaultGraph {
    const allEdges = [...explicitEdges];
    if (includeInferred) {
        allEdges.push(...buildTagEdges(nodes));
    }
    const adjacency = buildAdjacency(nodes, allEdges);
    const nodeMap = new Map<string, VaultNode>();
    for (const n of nodes) nodeMap.set(n.id, n);
    return { nodes, edges: allEdges, nodeMap, adjacency };
}

// --- BFS shortest path ---

/**
 * Find the shortest path between two nodes using BFS.
 * Returns the sequence of hops (edges) or null if no path exists.
 */
export function bfsShortestPath(
    adjacency: Map<string, Set<string>>,
    edges: VaultEdge[],
    from: string,
    to: string,
    maxHops: number = 5,
): PathHop[] | null {
    if (from === to) return [];
    if (!adjacency.has(from) || !adjacency.has(to)) return null;

    // Build edge lookup: for each pair, store the best edge
    const edgeLookup = new Map<string, VaultEdge>();
    for (const edge of edges) {
        const key1 = `${edge.from}::${edge.to}`;
        const key2 = `${edge.to}::${edge.from}`;
        // Prefer EXTRACTED edges over INFERRED
        if (!edgeLookup.has(key1) || edge.confidence === "EXTRACTED") {
            edgeLookup.set(key1, edge);
        }
        if (!edgeLookup.has(key2) || edge.confidence === "EXTRACTED") {
            edgeLookup.set(key2, edge);
        }
    }

    // BFS
    const visited = new Set<string>([from]);
    const queue: { node: string; path: PathHop[] }[] = [{ node: from, path: [] }];

    while (queue.length > 0) {
        const current = queue.shift()!;
        if (current.path.length >= maxHops) continue;

        const neighbors = adjacency.get(current.node);
        if (!neighbors) continue;

        for (const neighbor of neighbors) {
            if (visited.has(neighbor)) continue;

            const edgeKey = `${current.node}::${neighbor}`;
            const edge = edgeLookup.get(edgeKey);
            if (!edge) continue;

            const hop: PathHop = {
                from: current.node,
                to: neighbor,
                edgeType: edge.type,
                confidence: edge.confidence,
                ...(edge.sharedTags ? { sharedTags: edge.sharedTags } : {}),
            };
            const newPath = [...current.path, hop];

            if (neighbor === to) return newPath;

            visited.add(neighbor);
            queue.push({ node: neighbor, path: newPath });
        }
    }

    return null;
}

// --- Degree centrality ---

/**
 * Compute degree centrality for all nodes.
 */
export function computeDegreeCentrality(nodes: VaultNode[], edges: VaultEdge[]): CentralityResult[] {
    const degree = new Map<string, number>();
    const inDeg = new Map<string, number>();
    const outDeg = new Map<string, number>();

    for (const n of nodes) {
        degree.set(n.id, 0);
        inDeg.set(n.id, 0);
        outDeg.set(n.id, 0);
    }

    // Track unique connections (avoid double-counting parallel edges)
    const counted = new Set<string>();
    for (const edge of edges) {
        const pairKey = [edge.from, edge.to].sort().join("::");
        if (!counted.has(pairKey)) {
            counted.add(pairKey);
            degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
            degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
        }
        outDeg.set(edge.from, (outDeg.get(edge.from) || 0) + 1);
        inDeg.set(edge.to, (inDeg.get(edge.to) || 0) + 1);
    }

    const n = nodes.length;
    return nodes.map((node) => ({
        id: node.id,
        path: node.path,
        degree: degree.get(node.id) || 0,
        inDegree: inDeg.get(node.id) || 0,
        outDegree: outDeg.get(node.id) || 0,
        centrality: n > 1 ? (degree.get(node.id) || 0) / (n - 1) : 0,
    }));
}

// --- Label propagation (community detection) ---

/**
 * Detect communities using label propagation algorithm.
 * Each node starts with its own label, then iteratively adopts the most
 * frequent label among its neighbors. Converges when no labels change.
 */
export function labelPropagation(
    adjacency: Map<string, Set<string>>,
    nodes: VaultNode[],
    maxIterations: number = 100,
): Map<string, number> {
    // Initialize: each node gets its own index as label
    const labels = new Map<string, number>();
    const nodeIds = nodes.map((n) => n.id);
    nodeIds.forEach((id, i) => labels.set(id, i));

    for (let iter = 0; iter < maxIterations; iter++) {
        let changed = false;

        // Process nodes in random-ish order (shuffle by iteration)
        const order = [...nodeIds];
        for (let i = order.length - 1; i > 0; i--) {
            const j = (i * (iter + 1) * 7) % (i + 1);
            [order[i], order[j]] = [order[j], order[i]];
        }

        for (const nodeId of order) {
            const neighbors = adjacency.get(nodeId);
            if (!neighbors || neighbors.size === 0) continue;

            // Count neighbor labels
            const labelCount = new Map<number, number>();
            for (const neighbor of neighbors) {
                const label = labels.get(neighbor)!;
                labelCount.set(label, (labelCount.get(label) || 0) + 1);
            }

            // Find the most frequent label (break ties by smallest label)
            let maxCount = 0;
            let bestLabel = labels.get(nodeId)!;
            for (const [label, count] of labelCount) {
                if (count > maxCount || (count === maxCount && label < bestLabel)) {
                    maxCount = count;
                    bestLabel = label;
                }
            }

            if (labels.get(nodeId) !== bestLabel) {
                labels.set(nodeId, bestLabel);
                changed = true;
            }
        }

        if (!changed) break;
    }

    // Normalize labels to sequential integers starting from 0
    const uniqueLabels = [...new Set(labels.values())].sort((a, b) => a - b);
    const labelMap = new Map(uniqueLabels.map((l, i) => [l, i]));
    const result = new Map<string, number>();
    for (const [nodeId, label] of labels) {
        result.set(nodeId, labelMap.get(label)!);
    }

    return result;
}

// --- Orphan detection ---

/**
 * Find nodes with zero connections (orphans).
 */
export function findOrphans(adjacency: Map<string, Set<string>>, nodes: VaultNode[]): VaultNode[] {
    return nodes.filter((n) => {
        const neighbors = adjacency.get(n.id);
        return !neighbors || neighbors.size === 0;
    });
}

// --- Bridge detection ---

/**
 * Find approximate bridge nodes: nodes that connect different communities.
 * A bridge node has neighbors in more than one community.
 */
export function findBridges(
    adjacency: Map<string, Set<string>>,
    communities: Map<string, number>,
    nodes: VaultNode[],
): { node: VaultNode; connectsCommunities: number[] }[] {
    const bridges: { node: VaultNode; connectsCommunities: number[] }[] = [];

    for (const node of nodes) {
        const neighbors = adjacency.get(node.id);
        if (!neighbors || neighbors.size < 2) continue;

        const neighborCommunities = new Set<number>();
        const nodeCommunity = communities.get(node.id);
        for (const neighbor of neighbors) {
            const nc = communities.get(neighbor);
            if (nc !== undefined && nc !== nodeCommunity) {
                neighborCommunities.add(nc);
            }
        }

        if (neighborCommunities.size >= 2) {
            bridges.push({
                node,
                connectsCommunities: [nodeCommunity!, ...neighborCommunities].sort((a, b) => a - b),
            });
        }
    }

    // Sort by number of communities connected (descending)
    bridges.sort((a, b) => b.connectsCommunities.length - a.connectsCommunities.length);
    return bridges;
}

// --- Graph statistics ---

/**
 * Compute basic graph statistics.
 */
export function graphStats(nodes: VaultNode[], edges: VaultEdge[]) {
    const n = nodes.length;
    const m = edges.length;
    const maxEdges = (n * (n - 1)) / 2;
    const density = maxEdges > 0 ? m / maxEdges : 0;
    const avgDegree = n > 0 ? (2 * m) / n : 0;

    const extracted = edges.filter((e) => e.confidence === "EXTRACTED").length;
    const inferred = edges.filter((e) => e.confidence === "INFERRED").length;
    const wikiLinks = edges.filter((e) => e.type === "wiki").length;
    const markdownLinks = edges.filter((e) => e.type === "markdown").length;
    const sharedTagLinks = edges.filter((e) => e.type === "shared-tags").length;

    return {
        totalNodes: n,
        totalEdges: m,
        density: Math.round(density * 10000) / 10000,
        avgDegree: Math.round(avgDegree * 100) / 100,
        extractedEdges: extracted,
        inferredEdges: inferred,
        wikiLinks,
        markdownLinks,
        sharedTagLinks,
    };
}

// --- K-hop neighborhood ---

export interface NeighborhoodNote {
    id: string;
    path: string;
    tags: string[];
    /** How this note connects to the center note */
    connection: {
        type: "backlink" | "outgoing" | "shared-tags";
        /** The edge type (wiki, markdown, shared-tags) */
        edgeType: string;
        /** For shared-tags, the tags in common */
        sharedTags?: string[];
        /** Hop distance from center (1 = direct, 2 = neighbor-of-neighbor) */
        hop: number;
    };
}

export interface NeighborhoodResult {
    center: { id: string; path: string; tags: string[] };
    neighbors: NeighborhoodNote[];
    stats: {
        totalNeighbors: number;
        backlinks: number;
        outgoing: number;
        sharedTagNeighbors: number;
        maxHop: number;
    };
}

/**
 * Compute the k-hop neighborhood around a center node.
 * Returns all notes within `hops` edges of the center, annotated with
 * how they connect (backlink, outgoing, shared-tags) and their hop distance.
 */
export function kHopNeighborhood(
    graph: VaultGraph,
    centerId: string,
    hops: number = 1,
): NeighborhoodResult {
    const center = graph.nodeMap.get(centerId);
    if (!center) {
        return {
            center: { id: centerId, path: centerId, tags: [] },
            neighbors: [],
            stats: { totalNeighbors: 0, backlinks: 0, outgoing: 0, sharedTagNeighbors: 0, maxHop: 0 },
        };
    }

    // Classify direct edges from/to center
    const backlinks = new Map<string, VaultEdge>();
    const outgoing = new Map<string, VaultEdge>();
    const tagNeighbors = new Map<string, VaultEdge>();

    for (const edge of graph.edges) {
        if (edge.to === centerId && edge.from !== centerId) {
            if (!backlinks.has(edge.from) || edge.confidence === "EXTRACTED") {
                backlinks.set(edge.from, edge);
            }
        }
        if (edge.from === centerId && edge.to !== centerId) {
            if (!outgoing.has(edge.to) || edge.confidence === "EXTRACTED") {
                outgoing.set(edge.to, edge);
            }
        }
        if (edge.type === "shared-tags") {
            if (edge.from === centerId && !tagNeighbors.has(edge.to)) {
                tagNeighbors.set(edge.to, edge);
            }
            if (edge.to === centerId && !tagNeighbors.has(edge.from)) {
                tagNeighbors.set(edge.from, edge);
            }
        }
    }

    // BFS from center up to `hops` levels
    const visited = new Set<string>([centerId]);
    const neighbors: NeighborhoodNote[] = [];
    let currentFrontier = [centerId];

    for (let hop = 1; hop <= hops; hop++) {
        const nextFrontier: string[] = [];

        for (const nodeId of currentFrontier) {
            const nodeNeighbors = graph.adjacency.get(nodeId);
            if (!nodeNeighbors) continue;

            for (const neighborId of nodeNeighbors) {
                if (visited.has(neighborId)) continue;
                visited.add(neighborId);

                const neighborNode = graph.nodeMap.get(neighborId);
                if (!neighborNode) continue;

                // Determine connection type relative to center
                let connection: NeighborhoodNote["connection"];
                if (hop === 1) {
                    // Direct neighbor — classify by edge relationship to center
                    const blEdge = backlinks.get(neighborId);
                    const outEdge = outgoing.get(neighborId);
                    const tagEdge = tagNeighbors.get(neighborId);

                    if (blEdge) {
                        connection = { type: "backlink", edgeType: blEdge.type, hop };
                    } else if (outEdge) {
                        connection = { type: "outgoing", edgeType: outEdge.type, hop };
                    } else if (tagEdge) {
                        connection = {
                            type: "shared-tags",
                            edgeType: "shared-tags",
                            sharedTags: tagEdge.sharedTags,
                            hop,
                        };
                    } else {
                        connection = { type: "outgoing", edgeType: "wiki", hop };
                    }
                } else {
                    // Indirect neighbor — mark with hop distance
                    connection = { type: "outgoing", edgeType: "graph", hop };
                }

                neighbors.push({
                    id: neighborNode.id,
                    path: neighborNode.path,
                    tags: neighborNode.tags,
                    connection,
                });
                nextFrontier.push(neighborId);
            }
        }

        currentFrontier = nextFrontier;
        if (currentFrontier.length === 0) break;
    }

    const backlinkCount = neighbors.filter((n) => n.connection.type === "backlink").length;
    const outgoingCount = neighbors.filter((n) => n.connection.type === "outgoing").length;
    const tagCount = neighbors.filter((n) => n.connection.type === "shared-tags").length;

    return {
        center: { id: center.id, path: center.path, tags: center.tags },
        neighbors,
        stats: {
            totalNeighbors: neighbors.length,
            backlinks: backlinkCount,
            outgoing: outgoingCount,
            sharedTagNeighbors: tagCount,
            maxHop: hops,
        },
    };
}
