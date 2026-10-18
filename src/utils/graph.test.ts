/**
 * Unit tests for the graph engine.
 * Covers adjacency building, BFS pathfinding, centrality, community detection,
 * orphan/bridge detection, tag-based edge inference, and graph statistics.
 */
import { describe, it, expect } from "vitest";
import {
    buildAdjacency,
    buildTagEdges,
    buildFullGraph,
    bfsShortestPath,
    computeDegreeCentrality,
    labelPropagation,
    findOrphans,
    findBridges,
    graphStats,
    type VaultNode,
    type VaultEdge,
} from "./graph.js";

// ── Fixtures ──────────────────────────────────────────────────────────

function node(id: string, tags: string[] = []): VaultNode {
    return { id, path: `${id}.md`, tags };
}

function edge(from: string, to: string, type: VaultEdge["type"] = "wiki", confidence: VaultEdge["confidence"] = "EXTRACTED"): VaultEdge {
    return { from, to, type, confidence };
}

/** Triangle graph: A ↔ B ↔ C ↔ A */
function triangleFixture() {
    const nodes: VaultNode[] = [node("A"), node("B"), node("C")];
    const edges: VaultEdge[] = [edge("A", "B"), edge("B", "C"), edge("A", "C")];
    const adjacency = buildAdjacency(nodes, edges);
    return { nodes, edges, adjacency };
}

/** Linear graph: A → B → C → D */
function linearFixture() {
    const nodes: VaultNode[] = [node("A"), node("B"), node("C"), node("D")];
    const edges: VaultEdge[] = [edge("A", "B"), edge("B", "C"), edge("C", "D")];
    const adjacency = buildAdjacency(nodes, edges);
    return { nodes, edges, adjacency };
}

// ── buildAdjacency ────────────────────────────────────────────────────

describe("buildAdjacency", () => {
    it("creates undirected edges for all nodes", () => {
        const { adjacency } = triangleFixture();
        expect(adjacency.get("A")!.has("B")).toBe(true);
        expect(adjacency.get("A")!.has("C")).toBe(true);
        expect(adjacency.get("B")!.has("A")).toBe(true);
        expect(adjacency.get("C")!.has("A")).toBe(true);
    });

    it("initializes isolated nodes with empty neighbor sets", () => {
        const nodes = [node("lonely")];
        const adjacency = buildAdjacency(nodes, []);
        expect(adjacency.get("lonely")!.size).toBe(0);
    });

    it("adds adjacency entries for edge endpoints not in the node list", () => {
        const nodes = [node("A")];
        const edges = [edge("A", "B")];
        const adjacency = buildAdjacency(nodes, edges);
        expect(adjacency.has("B")).toBe(true);
        expect(adjacency.get("B")!.has("A")).toBe(true);
    });
});

// ── buildTagEdges ─────────────────────────────────────────────────────

describe("buildTagEdges", () => {
    it("connects nodes sharing at least minShared tags", () => {
        const nodes = [
            node("A", ["typescript", "mcp", "search"]),
            node("B", ["typescript", "mcp", "vault"]),
            node("C", ["python", "docker"]),
        ];
        const tagEdges = buildTagEdges(nodes, 2);
        expect(tagEdges).toHaveLength(1);
        expect(tagEdges[0].from).toBe("A");
        expect(tagEdges[0].to).toBe("B");
        expect(tagEdges[0].type).toBe("shared-tags");
        expect(tagEdges[0].confidence).toBe("INFERRED");
        expect(tagEdges[0].sharedTags).toEqual(expect.arrayContaining(["typescript", "mcp"]));
    });

    it("returns no edges when no pair meets the threshold", () => {
        const nodes = [
            node("A", ["typescript"]),
            node("B", ["python"]),
            node("C", ["rust"]),
        ];
        expect(buildTagEdges(nodes, 2)).toHaveLength(0);
    });

    it("defaults to minShared=2", () => {
        const nodes = [
            node("A", ["shared-a", "shared-b", "unique-a"]),
            node("B", ["shared-a", "shared-b", "unique-b"]),
        ];
        const tagEdges = buildTagEdges(nodes);
        expect(tagEdges).toHaveLength(1);
    });
});

// ── buildFullGraph ────────────────────────────────────────────────────

describe("buildFullGraph", () => {
    it("includes inferred tag edges by default", () => {
        const nodes = [
            node("A", ["typescript", "mcp"]),
            node("B", ["typescript", "mcp"]),
        ];
        const explicit: VaultEdge[] = [];
        const graph = buildFullGraph(nodes, explicit);
        expect(graph.edges.length).toBeGreaterThanOrEqual(1);
        expect(graph.edges.some((e) => e.type === "shared-tags")).toBe(true);
    });

    it("excludes inferred edges when includeInferred=false", () => {
        const nodes = [
            node("A", ["typescript", "mcp"]),
            node("B", ["typescript", "mcp"]),
        ];
        const graph = buildFullGraph(nodes, [], false);
        expect(graph.edges).toHaveLength(0);
    });

    it("builds a working nodeMap and adjacency", () => {
        const { nodes, edges } = triangleFixture();
        const graph = buildFullGraph(nodes, edges, false);
        expect(graph.nodeMap.size).toBe(3);
        expect(graph.nodeMap.get("A")).toBeDefined();
        expect(graph.adjacency.get("A")!.has("B")).toBe(true);
    });
});

// ── bfsShortestPath ───────────────────────────────────────────────────

describe("bfsShortestPath", () => {
    it("returns empty array when source equals target", () => {
        const { adjacency, edges } = triangleFixture();
        expect(bfsShortestPath(adjacency, edges, "A", "A")).toEqual([]);
    });

    it("finds direct path between connected nodes", () => {
        const { adjacency, edges } = triangleFixture();
        const path = bfsShortestPath(adjacency, edges, "A", "B");
        expect(path).not.toBeNull();
        expect(path).toHaveLength(1);
        expect(path![0].from).toBe("A");
        expect(path![0].to).toBe("B");
    });

    it("finds shortest path through intermediate nodes", () => {
        const { adjacency, edges } = linearFixture();
        const path = bfsShortestPath(adjacency, edges, "A", "D");
        expect(path).not.toBeNull();
        expect(path).toHaveLength(3);
        expect(path!.map((h) => h.to)).toEqual(["B", "C", "D"]);
    });

    it("returns null when no path exists", () => {
        const nodes = [node("A"), node("B")];
        const adjacency = buildAdjacency(nodes, []);
        expect(bfsShortestPath(adjacency, [], "A", "B")).toBeNull();
    });

    it("returns null for unknown node IDs", () => {
        const { adjacency } = triangleFixture();
        expect(bfsShortestPath(adjacency, [], "A", "Z")).toBeNull();
    });

    it("respects maxHops limit", () => {
        const { adjacency, edges } = linearFixture();
        const path = bfsShortestPath(adjacency, edges, "A", "D", 2);
        expect(path).toBeNull();
    });

    it("prefers EXTRACTED edges over INFERRED in path hops", () => {
        const nodes = [node("A"), node("B")];
        const edges: VaultEdge[] = [
            { from: "A", to: "B", type: "shared-tags", confidence: "INFERRED", sharedTags: ["ts"] },
            { from: "A", to: "B", type: "wiki", confidence: "EXTRACTED" },
        ];
        const adjacency = buildAdjacency(nodes, edges);
        const path = bfsShortestPath(adjacency, edges, "A", "B");
        expect(path).not.toBeNull();
        expect(path![0].edgeType).toBe("wiki");
        expect(path![0].confidence).toBe("EXTRACTED");
    });
});

// ── computeDegreeCentrality ───────────────────────────────────────────

describe("computeDegreeCentrality", () => {
    it("computes degree, inDegree, outDegree, and normalized centrality", () => {
        const { nodes, edges } = linearFixture();
        const results = computeDegreeCentrality(nodes, edges);
        const b = results.find((r) => r.id === "B")!;
        // B connects to A and C → degree 2
        expect(b.degree).toBe(2);
        expect(b.inDegree).toBe(1); // A→B
        expect(b.outDegree).toBe(1); // B→C
        // centrality = degree / (n-1) = 2/3
        expect(b.centrality).toBeCloseTo(2 / 3, 2);
    });

    it("returns zero centrality for isolated nodes", () => {
        const nodes = [node("lonely")];
        const results = computeDegreeCentrality(nodes, []);
        expect(results[0].degree).toBe(0);
        expect(results[0].centrality).toBe(0);
    });

    it("avoids double-counting parallel edges between same pair", () => {
        const nodes = [node("A"), node("B")];
        const edges: VaultEdge[] = [edge("A", "B", "wiki"), edge("A", "B", "markdown")];
        const results = computeDegreeCentrality(nodes, edges);
        // degree counts unique pairs, so A has degree 1
        expect(results.find((r) => r.id === "A")!.degree).toBe(1);
        // but inDegree/outDegree count all edges
        expect(results.find((r) => r.id === "B")!.inDegree).toBe(2);
    });
});

// ── labelPropagation ──────────────────────────────────────────────────

describe("labelPropagation", () => {
    it("assigns the same community to tightly connected nodes", () => {
        // Two cliques connected by a bridge
        const nodes = [node("A"), node("B"), node("C"), node("D"), node("E"), node("F")];
        const edges = [
            edge("A", "B"), edge("A", "C"), edge("B", "C"), // clique 1
            edge("D", "E"), edge("D", "F"), edge("E", "F"), // clique 2
            edge("C", "D"), // bridge
        ];
        const adjacency = buildAdjacency(nodes, edges);
        const communities = labelPropagation(adjacency, nodes);

        // Nodes in the same clique should share a community
        expect(communities.get("A")).toBe(communities.get("B"));
        expect(communities.get("A")).toBe(communities.get("C"));
        expect(communities.get("D")).toBe(communities.get("E"));
        expect(communities.get("D")).toBe(communities.get("F"));
    });

    it("handles isolated nodes as their own community", () => {
        const nodes = [node("A"), node("B")];
        const adjacency = buildAdjacency(nodes, []);
        const communities = labelPropagation(adjacency, nodes);
        expect(communities.get("A")).not.toBe(communities.get("B"));
    });

    it("returns normalized sequential labels starting from 0", () => {
        const { nodes, edges } = triangleFixture();
        const communities = labelPropagation(buildAdjacency(nodes, edges), nodes);
        const labels = [...new Set(communities.values())].sort((a, b) => a - b);
        expect(labels[0]).toBe(0);
    });
});

// ── findOrphans ───────────────────────────────────────────────────────

describe("findOrphans", () => {
    it("returns nodes with zero connections", () => {
        const nodes = [node("A"), node("B"), node("orphan")];
        const edges = [edge("A", "B")];
        const adjacency = buildAdjacency(nodes, edges);
        const orphans = findOrphans(adjacency, nodes);
        expect(orphans).toHaveLength(1);
        expect(orphans[0].id).toBe("orphan");
    });

    it("returns empty array when all nodes are connected", () => {
        const { nodes, adjacency } = triangleFixture();
        expect(findOrphans(adjacency, nodes)).toHaveLength(0);
    });
});

// ── findBridges ───────────────────────────────────────────────────────

describe("findBridges", () => {
    it("identifies nodes connecting different communities", () => {
        // Bridge node connects to neighbors in 2 communities different from its own
        const nodes = [node("A"), node("B"), node("bridge"), node("C"), node("D"), node("E")];
        const edges = [
            edge("A", "B"),           // community 0 internal
            edge("bridge", "A"),       // bridge → community 0
            edge("bridge", "C"),       // bridge → community 1
            edge("bridge", "D"),       // bridge → community 1
            edge("bridge", "E"),       // bridge → community 2
            edge("C", "D"),            // community 1 internal
        ];
        const adjacency = buildAdjacency(nodes, edges);
        // Bridge is in community 0, its neighbors span communities 1 and 2
        const communities = new Map([
            ["A", 0], ["B", 0], ["bridge", 0], ["C", 1], ["D", 1], ["E", 2],
        ]);
        const bridges = findBridges(adjacency, communities, nodes);
        const bridgeNode = bridges.find((b) => b.node.id === "bridge");
        expect(bridgeNode).toBeDefined();
        expect(bridgeNode!.connectsCommunities.length).toBeGreaterThanOrEqual(2);
    });

    it("returns empty array when no node connects multiple communities", () => {
        const nodes = [node("A"), node("B")];
        const edges = [edge("A", "B")];
        const adjacency = buildAdjacency(nodes, edges);
        const communities = new Map([["A", 0], ["B", 0]]);
        expect(findBridges(adjacency, communities, nodes)).toHaveLength(0);
    });
});

// ── graphStats ────────────────────────────────────────────────────────

describe("graphStats", () => {
    it("computes correct node/edge counts and density", () => {
        const { nodes, edges } = triangleFixture();
        const stats = graphStats(nodes, edges);
        expect(stats.totalNodes).toBe(3);
        expect(stats.totalEdges).toBe(3);
        // density = 3 / (3*2/2) = 1.0 (complete graph)
        expect(stats.density).toBe(1);
    });

    it("categorizes edges by type and confidence", () => {
        const nodes = [node("A"), node("B"), node("C")];
        const edges: VaultEdge[] = [
            edge("A", "B", "wiki"),
            edge("B", "C", "markdown"),
            { from: "A", to: "C", type: "shared-tags", confidence: "INFERRED", sharedTags: ["ts"] },
        ];
        const stats = graphStats(nodes, edges);
        expect(stats.wikiLinks).toBe(1);
        expect(stats.markdownLinks).toBe(1);
        expect(stats.sharedTagLinks).toBe(1);
        expect(stats.extractedEdges).toBe(2);
        expect(stats.inferredEdges).toBe(1);
    });

    it("returns zero density for empty graph", () => {
        expect(graphStats([], []).density).toBe(0);
    });

    it("computes avgDegree correctly", () => {
        const { nodes, edges } = triangleFixture();
        const stats = graphStats(nodes, edges);
        // avgDegree = 2*3/3 = 2
        expect(stats.avgDegree).toBe(2);
    });
});
