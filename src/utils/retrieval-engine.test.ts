/**
 * Unit tests for the retrieval engine.
 * Covers BM25 scoring, composite score computation, and the retrieve/recall pipeline.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { computeBm25Score, retrieve, recall } from "./retrieval-engine.js";
import { metadataIndex } from "./metadata-index.js";
import { initVault } from "./vault.js";
import type { MemoryMetadata } from "./memory-schema.js";
import type { InvertedIndex } from "./metadata-index.js";
import { mkdirSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";

// ── Helpers ───────────────────────────────────────────────────────────

function makeInvertedIndex(docs: Record<string, string>): InvertedIndex {
    const postings = new Map<string, Map<string, { tf: number }>>();
    const docLengths = new Map<string, number>();

    for (const [docId, text] of Object.entries(docs)) {
        const tokens = text.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
        docLengths.set(docId, tokens.length);
        const tf = new Map<string, number>();
        for (const token of tokens) {
            tf.set(token, (tf.get(token) ?? 0) + 1);
        }
        for (const [token, count] of tf) {
            if (!postings.has(token)) postings.set(token, new Map());
            postings.get(token)!.set(docId, { tf: count });
        }
    }

    const lengths = [...docLengths.values()];
    const avgDocLength = lengths.length > 0 ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;

    return { postings, docLengths, avgDocLength, docCount: Object.keys(docs).length };
}

function makeMemory(overrides: Partial<MemoryMetadata> = {}): MemoryMetadata {
    return {
        id: overrides.id ?? "mem_test_001",
        type: overrides.type ?? "FACT",
        status: overrides.status ?? "ACTIVE",
        confidence: overrides.confidence ?? 0.8,
        project: overrides.project ?? "test-project",
        created: overrides.created ?? "2026-01-01T00:00:00Z",
        updated: overrides.updated ?? new Date().toISOString(),
        source_type: overrides.source_type ?? "AGENT",
        importance: overrides.importance ?? "NORMAL",
        entity: overrides.entity,
        related: overrides.related ?? [],
        tags: overrides.tags ?? [],
        filePath: overrides.filePath ?? "memories/test.md",
        contentPreview: overrides.contentPreview ?? "test content",
        wordCount: overrides.wordCount ?? 10,
        lastIndexed: overrides.lastIndexed ?? "2026-01-01T00:00:00Z",
        supersedes: overrides.supersedes,
        superseded_by: overrides.superseded_by,
        source_reference: overrides.source_reference,
    };
}

function injectMemory(mem: MemoryMetadata): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = metadataIndex as any;
    internals.memories.set(mem.id, mem);
    // Update secondary indexes
    const projectKey = mem.project.toLowerCase();
    if (!internals.byProject.has(projectKey)) internals.byProject.set(projectKey, new Set());
    internals.byProject.get(projectKey).add(mem.id);
    if (!internals.byType.has(mem.type)) internals.byType.set(mem.type, new Set());
    internals.byType.get(mem.type).add(mem.id);
    if (!internals.byStatus.has(mem.status)) internals.byStatus.set(mem.status, new Set());
    internals.byStatus.get(mem.status).add(mem.id);
    if (mem.entity) {
        const entityKey = mem.entity.toLowerCase();
        if (!internals.byEntity.has(entityKey)) internals.byEntity.set(entityKey, new Set());
        internals.byEntity.get(entityKey).add(mem.id);
    }
}

const TEST_VAULT = resolve(process.cwd(), ".test-vault-retrieval");

beforeAll(() => {
    rmSync(TEST_VAULT, { recursive: true, force: true });
    mkdirSync(TEST_VAULT, { recursive: true });
    mkdirSync(join(TEST_VAULT, "memories"), { recursive: true });
    process.env.NOTES_VAULT_PATH = TEST_VAULT;
    initVault();
});

afterAll(() => {
    rmSync(TEST_VAULT, { recursive: true, force: true });
    delete process.env.NOTES_VAULT_PATH;
});

// ── computeBm25Score ──────────────────────────────────────────────────

describe("computeBm25Score", () => {
    it("returns 0 for empty query tokens", () => {
        const index = makeInvertedIndex({ doc1: "hello world" });
        expect(computeBm25Score("doc1", [], index, 1.2, 0.75)).toBe(0);
    });

    it("returns 0 when query tokens are not in the index", () => {
        const index = makeInvertedIndex({ doc1: "hello world" });
        expect(computeBm25Score("doc1", ["missing"], index, 1.2, 0.75)).toBe(0);
    });

    it("returns positive score for matching tokens", () => {
        const index = makeInvertedIndex({
            doc1: "database postgres storage",
            doc2: "frontend react components",
        });
        const score = computeBm25Score("doc1", ["database", "postgres"], index, 1.2, 0.75);
        expect(score).toBeGreaterThan(0);
    });

    it("ranks documents with more matching tokens higher", () => {
        const index = makeInvertedIndex({
            doc1: "database postgres storage engine",
            doc2: "database frontend react",
        });
        const score1 = computeBm25Score("doc1", ["database", "postgres", "storage"], index, 1.2, 0.75);
        const score2 = computeBm25Score("doc2", ["database", "postgres", "storage"], index, 1.2, 0.75);
        expect(score1).toBeGreaterThan(score2);
    });

    it("returns 0 for a docId not in the index", () => {
        const index = makeInvertedIndex({ doc1: "hello world" });
        expect(computeBm25Score("nonexistent", ["hello"], index, 1.2, 0.75)).toBe(0);
    });
});

// ── retrieve ──────────────────────────────────────────────────────────

describe("retrieve", () => {
    beforeEach(() => {
        metadataIndex.invalidate();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (metadataIndex as any).initialized = true;
    });

    it("returns memories filtered by project", async () => {
        injectMemory(makeMemory({ id: "mem_proj_a", project: "alpha", contentPreview: "alpha memory" }));
        injectMemory(makeMemory({ id: "mem_proj_b", project: "beta", contentPreview: "beta memory" }));

        const results = await retrieve({ project: "alpha", mode: "standard" });
        expect(results).toHaveLength(1);
        expect(results[0].memory.id).toBe("mem_proj_a");
    });

    it("excludes archived memories in compact and standard mode", async () => {
        injectMemory(makeMemory({ id: "mem_active", status: "ACTIVE" }));
        injectMemory(makeMemory({ id: "mem_archived", status: "ARCHIVED" }));

        const results = await retrieve({ mode: "standard" });
        expect(results.some((r) => r.memory.id === "mem_active")).toBe(true);
        expect(results.some((r) => r.memory.id === "mem_archived")).toBe(false);
    });

    it("includes archived memories in deep mode", async () => {
        injectMemory(makeMemory({ id: "mem_active", status: "ACTIVE" }));
        injectMemory(makeMemory({ id: "mem_archived", status: "ARCHIVED" }));

        const results = await retrieve({ mode: "deep" });
        expect(results.some((r) => r.memory.id === "mem_archived")).toBe(true);
    });

    it("respects the limit parameter", async () => {
        for (let i = 0; i < 10; i++) {
            injectMemory(makeMemory({ id: `mem_limit_${i}`, contentPreview: `memory number ${i}` }));
        }
        const results = await retrieve({ mode: "deep", limit: 3 });
        expect(results).toHaveLength(3);
    });

    it("applies mode-based default limits", async () => {
        for (let i = 0; i < 30; i++) {
            injectMemory(makeMemory({ id: `mem_mode_${i}`, contentPreview: `content ${i}` }));
        }
        const compact = await retrieve({ mode: "compact" });
        expect(compact.length).toBeLessThanOrEqual(5);
    });

    it("filters by type when specified", async () => {
        injectMemory(makeMemory({ id: "mem_decision", type: "DECISION" }));
        injectMemory(makeMemory({ id: "mem_fact", type: "FACT" }));

        const results = await retrieve({ mode: "standard", type: "DECISION" });
        expect(results).toHaveLength(1);
        expect(results[0].memory.type).toBe("DECISION");
    });

    it("excludes context memory IDs from results", async () => {
        injectMemory(makeMemory({ id: "mem_ctx_1" }));
        injectMemory(makeMemory({ id: "mem_ctx_2" }));

        const results = await retrieve({ mode: "standard", contextMemoryIds: ["mem_ctx_1"] });
        expect(results.some((r) => r.memory.id === "mem_ctx_1")).toBe(false);
    });

    it("ranks higher-confidence memories above lower-confidence ones", async () => {
        injectMemory(makeMemory({ id: "mem_high_conf", confidence: 0.95, contentPreview: "shared topic" }));
        injectMemory(makeMemory({ id: "mem_low_conf", confidence: 0.2, contentPreview: "shared topic" }));

        const results = await retrieve({ mode: "standard" });
        const highIdx = results.findIndex((r) => r.memory.id === "mem_high_conf");
        const lowIdx = results.findIndex((r) => r.memory.id === "mem_low_conf");
        expect(highIdx).toBeLessThan(lowIdx);
    });
});

// ── recall ────────────────────────────────────────────────────────────

describe("recall", () => {
    beforeEach(() => {
        metadataIndex.invalidate();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (metadataIndex as any).initialized = true;
    });

    it("returns top memories for a project with default limit of 10", async () => {
        for (let i = 0; i < 15; i++) {
            injectMemory(makeMemory({ id: `mem_recall_${i}`, project: "myproject" }));
        }
        const results = await recall("myproject");
        expect(results.length).toBeLessThanOrEqual(10);
        expect(results.every((r) => r.memory.project === "myproject")).toBe(true);
    });
});
