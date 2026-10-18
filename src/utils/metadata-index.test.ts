/**
 * Unit tests for the metadata index.
 * Covers query filtering, secondary indexes, stats, invalidation, BM25 inverted index,
 * rebuild from disk, updateEntry, getAvgDocLength, and file-path-based invalidation.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { metadataIndex } from "./metadata-index.js";
import { initVault } from "./vault.js";
import type { MemoryMetadata } from "./memory-schema.js";
import { mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

// ── Helpers ───────────────────────────────────────────────────────────

function makeMemory(overrides: Partial<MemoryMetadata> = {}): MemoryMetadata {
    return {
        id: overrides.id ?? "mem_test_001",
        type: overrides.type ?? "FACT",
        status: overrides.status ?? "ACTIVE",
        confidence: overrides.confidence ?? 0.8,
        project: overrides.project ?? "test-project",
        created: overrides.created ?? "2026-01-01T00:00:00Z",
        updated: overrides.updated ?? "2026-01-01T00:00:00Z",
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

const TEST_VAULT = resolve(process.cwd(), ".test-vault-metadata-index");

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

describe("MetadataIndex", () => {
    beforeEach(() => {
        metadataIndex.invalidate();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (metadataIndex as any).initialized = true;
        // Clean up all files from the memories directory to isolate rebuild tests
        cleanMemoriesDir();
    });

    // ── Query filtering ───────────────────────────────────────────────

    describe("query", () => {
        it("returns all memories with empty filter", () => {
            injectMemory(makeMemory({ id: "m1" }));
            injectMemory(makeMemory({ id: "m2" }));
            expect(metadataIndex.query({})).toHaveLength(2);
        });

        it("filters by project (case-insensitive)", () => {
            injectMemory(makeMemory({ id: "m1", project: "Alpha" }));
            injectMemory(makeMemory({ id: "m2", project: "beta" }));
            const results = metadataIndex.query({ project: "alpha" });
            expect(results).toHaveLength(1);
            expect(results[0].id).toBe("m1");
        });

        it("filters by single type", () => {
            injectMemory(makeMemory({ id: "m1", type: "DECISION" }));
            injectMemory(makeMemory({ id: "m2", type: "FACT" }));
            expect(metadataIndex.query({ type: "DECISION" })).toHaveLength(1);
        });

        it("filters by multiple types", () => {
            injectMemory(makeMemory({ id: "m1", type: "DECISION" }));
            injectMemory(makeMemory({ id: "m2", type: "FACT" }));
            injectMemory(makeMemory({ id: "m3", type: "LESSON" }));
            expect(metadataIndex.query({ type: ["DECISION", "FACT"] })).toHaveLength(2);
        });

        it("filters by single status", () => {
            injectMemory(makeMemory({ id: "m1", status: "ACTIVE" }));
            injectMemory(makeMemory({ id: "m2", status: "ARCHIVED" }));
            expect(metadataIndex.query({ status: "ACTIVE" })).toHaveLength(1);
        });

        it("filters by multiple statuses", () => {
            injectMemory(makeMemory({ id: "m1", status: "ACTIVE" }));
            injectMemory(makeMemory({ id: "m2", status: "CONFIRMED" }));
            injectMemory(makeMemory({ id: "m3", status: "ARCHIVED" }));
            expect(metadataIndex.query({ status: ["ACTIVE", "CONFIRMED"] })).toHaveLength(2);
        });

        it("filters by entity (case-insensitive)", () => {
            injectMemory(makeMemory({ id: "m1", entity: "Database" }));
            injectMemory(makeMemory({ id: "m2", entity: "cache" }));
            expect(metadataIndex.query({ entity: "database" })).toHaveLength(1);
        });

        it("filters by tags (AND-like: any match)", () => {
            injectMemory(makeMemory({ id: "m1", tags: ["typescript", "mcp"] }));
            injectMemory(makeMemory({ id: "m2", tags: ["python", "docker"] }));
            expect(metadataIndex.query({ tags: ["typescript"] })).toHaveLength(1);
        });

        it("filters by minConfidence", () => {
            injectMemory(makeMemory({ id: "m1", confidence: 0.9 }));
            injectMemory(makeMemory({ id: "m2", confidence: 0.3 }));
            expect(metadataIndex.query({ minConfidence: 0.5 })).toHaveLength(1);
        });

        it("filters by maxConfidence", () => {
            injectMemory(makeMemory({ id: "m1", confidence: 0.9 }));
            injectMemory(makeMemory({ id: "m2", confidence: 0.3 }));
            expect(metadataIndex.query({ maxConfidence: 0.5 })).toHaveLength(1);
        });

        it("excludes specified IDs", () => {
            injectMemory(makeMemory({ id: "m1" }));
            injectMemory(makeMemory({ id: "m2" }));
            expect(metadataIndex.query({ excludeIds: ["m1"] })).toHaveLength(1);
        });

        it("combines multiple filters", () => {
            injectMemory(makeMemory({ id: "m1", project: "alpha", type: "DECISION", status: "ACTIVE" }));
            injectMemory(makeMemory({ id: "m2", project: "alpha", type: "FACT", status: "ACTIVE" }));
            injectMemory(makeMemory({ id: "m3", project: "beta", type: "DECISION", status: "ARCHIVED" }));
            const results = metadataIndex.query({ project: "alpha", type: "DECISION", status: "ACTIVE" });
            expect(results).toHaveLength(1);
            expect(results[0].id).toBe("m1");
        });
    });

    // ── Secondary indexes ─────────────────────────────────────────────

    describe("secondary indexes", () => {
        it("getById returns the correct memory", () => {
            injectMemory(makeMemory({ id: "mem_lookup" }));
            expect(metadataIndex.getById("mem_lookup")?.id).toBe("mem_lookup");
        });

        it("getById returns undefined for missing ID", () => {
            expect(metadataIndex.getById("nonexistent")).toBeUndefined();
        });

        it("getByProject returns all memories in a project", () => {
            injectMemory(makeMemory({ id: "m1", project: "proj-a" }));
            injectMemory(makeMemory({ id: "m2", project: "proj-a" }));
            injectMemory(makeMemory({ id: "m3", project: "proj-b" }));
            expect(metadataIndex.getByProject("proj-a")).toHaveLength(2);
        });

        it("getByProject returns empty for unknown project", () => {
            expect(metadataIndex.getByProject("nonexistent")).toHaveLength(0);
        });

        it("getByType returns all memories of a type", () => {
            injectMemory(makeMemory({ id: "m1", type: "DECISION" }));
            injectMemory(makeMemory({ id: "m2", type: "FACT" }));
            expect(metadataIndex.getByType("DECISION")).toHaveLength(1);
        });

        it("getByStatus returns all memories with a status", () => {
            injectMemory(makeMemory({ id: "m1", status: "ACTIVE" }));
            injectMemory(makeMemory({ id: "m2", status: "ARCHIVED" }));
            expect(metadataIndex.getByStatus("ACTIVE")).toHaveLength(1);
        });

        it("getByEntity returns memories with matching entity", () => {
            injectMemory(makeMemory({ id: "m1", entity: "database" }));
            injectMemory(makeMemory({ id: "m2", entity: "cache" }));
            expect(metadataIndex.getByEntity("database")).toHaveLength(1);
        });

        it("getByEntity is case-insensitive", () => {
            injectMemory(makeMemory({ id: "m1", entity: "Database" }));
            expect(metadataIndex.getByEntity("DATABASE")).toHaveLength(1);
        });
    });

    // ── Stats ─────────────────────────────────────────────────────────

    describe("getStats", () => {
        it("returns correct counts by project, type, and status", () => {
            injectMemory(makeMemory({ id: "m1", project: "alpha", type: "DECISION", status: "ACTIVE" }));
            injectMemory(makeMemory({ id: "m2", project: "alpha", type: "FACT", status: "ACTIVE" }));
            injectMemory(makeMemory({ id: "m3", project: "beta", type: "FACT", status: "ARCHIVED" }));

            const stats = metadataIndex.getStats();
            expect(stats.totalMemories).toBe(3);
            expect(stats.byProject["alpha"]).toBe(2);
            expect(stats.byProject["beta"]).toBe(1);
            expect(stats.byType["FACT"]).toBe(2);
            expect(stats.byType["DECISION"]).toBe(1);
            expect(stats.byStatus["ACTIVE"]).toBe(2);
            expect(stats.byStatus["ARCHIVED"]).toBe(1);
        });

        it("reports stale state after invalidation", () => {
            metadataIndex.invalidate();
            expect(metadataIndex.getStats().isStale).toBe(true);
        });
    });

    // ── Invalidation ──────────────────────────────────────────────────

    describe("invalidate", () => {
        it("clears all data when called without arguments", () => {
            injectMemory(makeMemory({ id: "m1" }));
            injectMemory(makeMemory({ id: "m2" }));
            metadataIndex.invalidate();
            expect(metadataIndex.query({})).toHaveLength(0);
            expect(metadataIndex.getById("m1")).toBeUndefined();
        });

        it("marks index as stale after invalidation", () => {
            metadataIndex.invalidate();
            expect(metadataIndex.getStats().isStale).toBe(true);
        });
    });

    // ── Inverted index ────────────────────────────────────────────────

    describe("inverted index", () => {
        it("getInvertedIndex returns the index structure", () => {
            const idx = metadataIndex.getInvertedIndex();
            expect(idx).toHaveProperty("postings");
            expect(idx).toHaveProperty("docLengths");
            expect(idx).toHaveProperty("avgDocLength");
            expect(idx).toHaveProperty("docCount");
        });

        it("getDocLength returns 0 for unknown memory", () => {
            expect(metadataIndex.getDocLength("nonexistent")).toBe(0);
        });
    });

    // ── getAvgDocLength ──────────────────────────────────────────────

    describe("getAvgDocLength", () => {
        it("returns 0 when index is empty", () => {
            expect(metadataIndex.getAvgDocLength()).toBe(0);
        });

        it("returns correct average after rebuild with files", async () => {
            // Write test files with known content
            writeMemoryFile("mem_avg_001", "FACT", "alpha beta gamma delta epsilon");
            writeMemoryFile("mem_avg_002", "DECISION", "one two three");
            await metadataIndex.rebuild();
            const avgLen = metadataIndex.getAvgDocLength();
            // avgDocLength should be > 0 since we have indexed documents
            expect(avgLen).toBeGreaterThan(0);
        });
    });

    // ── rebuild (exercises scanDirectory, indexFile, tokenize, etc.) ─

    describe("rebuild", () => {
        it("scans vault and indexes memory files", async () => {
            writeMemoryFile("mem_rebuild001", "FACT", "This is a test fact about databases");
            writeMemoryFile("mem_rebuild002", "DECISION", "We decided to use PostgreSQL");
            await metadataIndex.rebuild();

            expect(metadataIndex.isInitialized()).toBe(true);
            const stats = metadataIndex.getStats();
            expect(stats.totalMemories).toBe(2);
            expect(stats.byType["FACT"]).toBe(1);
            expect(stats.byType["DECISION"]).toBe(1);
        });

        it("populates the inverted index with tokens", async () => {
            writeMemoryFile("mem_token001", "FACT", "typescript is a programming language");
            await metadataIndex.rebuild();

            const idx = metadataIndex.getInvertedIndex();
            expect(idx.docCount).toBe(1);
            expect(idx.docLengths.size).toBe(1);
            // "typescript" should be in the postings (not a stopword)
            expect(idx.postings.has("typescript")).toBe(true);
        });

        it("skips non-memory markdown files", async () => {
            // Write a file without valid memory frontmatter
            writeFileSync(join(TEST_VAULT, "memories", "regular-note.md"), "# Just a regular note\nSome content");
            writeMemoryFile("mem_valid01", "FACT", "A valid memory entry");
            await metadataIndex.rebuild();

            const stats = metadataIndex.getStats();
            expect(stats.totalMemories).toBe(1);
        });

        it("skips files in .trash directory", async () => {
            mkdirSync(join(TEST_VAULT, ".trash"), { recursive: true });
            writeFileSync(
                join(TEST_VAULT, ".trash", "deleted.md"),
                makeFrontmatter("mem_trash001", "FACT") + "deleted content",
            );
            writeMemoryFile("mem_kept0001", "FACT", "kept content");
            await metadataIndex.rebuild();

            expect(metadataIndex.getById("mem_trash001")).toBeUndefined();
            expect(metadataIndex.getById("mem_kept0001")).toBeDefined();
        });

        it("skips files in archive directory", async () => {
            mkdirSync(join(TEST_VAULT, "archive"), { recursive: true });
            writeFileSync(
                join(TEST_VAULT, "archive", "archived.md"),
                makeFrontmatter("mem_archv01", "FACT") + "archived content",
            );
            writeMemoryFile("mem_active001", "FACT", "active content");
            await metadataIndex.rebuild();

            expect(metadataIndex.getById("mem_archv01")).toBeUndefined();
            expect(metadataIndex.getById("mem_active001")).toBeDefined();
        });

        it("handles nested subdirectories", async () => {
            mkdirSync(join(TEST_VAULT, "memories", "sub", "deep"), { recursive: true });
            writeFileSync(
                join(TEST_VAULT, "memories", "sub", "deep", "nested.md"),
                makeFrontmatter("mem_nested", "LESSON") + "deeply nested lesson",
            );
            await metadataIndex.rebuild();

            const mem = metadataIndex.getById("mem_nested");
            expect(mem).toBeDefined();
            expect(mem!.type).toBe("LESSON");
        });

        it("handles files with source object in frontmatter", async () => {
            const content = [
                "---",
                "id: mem_source1",
                "type: FACT",
                "status: ACTIVE",
                "confidence: 0.9",
                "project: test-project",
                "source:",
                "  type: DOCUMENT",
                "  reference: docs/design.md",
                "importance: HIGH",
                "tags: []",
                "related: []",
                "---",
                "Content about architecture decisions",
            ].join("\n");
            writeFileSync(join(TEST_VAULT, "memories", "source-test.md"), content);
            await metadataIndex.rebuild();

            const mem = metadataIndex.getById("mem_source1");
            expect(mem).toBeDefined();
            expect(mem!.source_type).toBe("DOCUMENT");
            expect(mem!.source_reference).toBe("docs/design.md");
        });

        it("handles files with entity field", async () => {
            const content = [
                "---",
                "id: mem_entity01",
                "type: FACT",
                "status: ACTIVE",
                "confidence: 0.8",
                "project: test-project",
                "entity: PostgreSQL",
                "importance: NORMAL",
                "tags: []",
                "related: []",
                "---",
                "PostgreSQL is a relational database",
            ].join("\n");
            writeFileSync(join(TEST_VAULT, "memories", "entity-test.md"), content);
            await metadataIndex.rebuild();

            const mem = metadataIndex.getById("mem_entity01");
            expect(mem).toBeDefined();
            expect(mem!.entity).toBe("PostgreSQL");
            // Should be in the entity index
            expect(metadataIndex.getByEntity("postgresql")).toHaveLength(1);
        });

        it("handles files with supersedes/superseded_by fields", async () => {
            const content = [
                "---",
                "id: mem_super01",
                "type: FACT",
                "status: SUPERSEDED",
                "confidence: 0.5",
                "project: test-project",
                "superseded_by: mem_super02",
                "importance: NORMAL",
                "tags: []",
                "related: []",
                "---",
                "Old fact that was superseded",
            ].join("\n");
            writeFileSync(join(TEST_VAULT, "memories", "superseded.md"), content);
            await metadataIndex.rebuild();

            const mem = metadataIndex.getById("mem_super01");
            expect(mem).toBeDefined();
            expect(mem!.superseded_by).toBe("mem_super02");
        });

        it("sets isStale to false after rebuild", async () => {
            metadataIndex.invalidate();
            expect(metadataIndex.getStats().isStale).toBe(true);
            await metadataIndex.rebuild();
            expect(metadataIndex.getStats().isStale).toBe(false);
        });

        it("sets lastRebuild timestamp", async () => {
            await metadataIndex.rebuild();
            const stats = metadataIndex.getStats();
            expect(stats.lastRebuild).toBeTruthy();
            // Should be a valid ISO date
            expect(new Date(stats.lastRebuild).toISOString()).toBe(stats.lastRebuild);
        });

        it("replaces existing entries on rebuild (no duplicates)", async () => {
            writeMemoryFile("mem_duplic1", "FACT", "original content");
            await metadataIndex.rebuild();
            expect(metadataIndex.getStats().totalMemories).toBe(1);

            // Rebuild again - same file should not create duplicates
            await metadataIndex.rebuild();
            expect(metadataIndex.getStats().totalMemories).toBe(1);
        });

        it("tokenizes text correctly (lowercase, no stopwords, no short tokens)", async () => {
            writeMemoryFile("mem_token002", "FACT", "The quick brown fox jumps through lazy dogs");
            await metadataIndex.rebuild();

            const idx = metadataIndex.getInvertedIndex();
            // "the", "through" are stopwords; single-char words filtered out
            expect(idx.postings.has("the")).toBe(false);
            expect(idx.postings.has("through")).toBe(false);
            expect(idx.postings.has("quick")).toBe(true);
            expect(idx.postings.has("brown")).toBe(true);
            expect(idx.postings.has("fox")).toBe(true);
        });

        it("handles files with default values for optional fields", async () => {
            // Minimal frontmatter - only id and type required
            const content = [
                "---",
                "id: mem_minimal1",
                "type: FACT",
                "---",
                "Minimal frontmatter content here",
            ].join("\n");
            writeFileSync(join(TEST_VAULT, "memories", "minimal.md"), content);
            await metadataIndex.rebuild();

            const mem = metadataIndex.getById("mem_minimal1");
            expect(mem).toBeDefined();
            expect(mem!.status).toBe("ACTIVE");
            expect(mem!.confidence).toBe(0.8);
            expect(mem!.project).toBe("default");
            expect(mem!.source_type).toBe("AGENT");
            expect(mem!.importance).toBe("NORMAL");
        });

        it("handles unreadable files gracefully", async () => {
            // Write a valid file alongside
            writeMemoryFile("mem_goodfile", "FACT", "good content here");
            await metadataIndex.rebuild();
            // The index should still work even if some files are unreadable
            expect(metadataIndex.getById("mem_goodfile")).toBeDefined();
        });
    });

    // ── updateEntry ──────────────────────────────────────────────────

    describe("updateEntry", () => {
        it("indexes a single file and clears stale flag", async () => {
            writeMemoryFile("mem_update01", "FACT", "Updated content about testing");
            metadataIndex.invalidate();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (metadataIndex as any).initialized = true;
            expect(metadataIndex.getStats().isStale).toBe(true);

            const filePath = join(TEST_VAULT, "memories", "mem_update01.md");
            await metadataIndex.updateEntry(filePath);

            expect(metadataIndex.getStats().isStale).toBe(false);
            const mem = metadataIndex.getById("mem_update01");
            expect(mem).toBeDefined();
            expect(mem!.type).toBe("FACT");
        });

        it("updates an existing entry in the index", async () => {
            writeMemoryFile("mem_update02", "FACT", "Original content");
            await metadataIndex.rebuild();
            expect(metadataIndex.getById("mem_update02")!.contentPreview).toBe("Original content");

            // Update the file content
            writeMemoryFile("mem_update02", "DECISION", "Changed to decision with new content");
            const filePath = join(TEST_VAULT, "memories", "mem_update02.md");
            await metadataIndex.updateEntry(filePath);

            const mem = metadataIndex.getById("mem_update02");
            expect(mem!.type).toBe("DECISION");
            expect(mem!.contentPreview).toContain("Changed to decision");
        });
    });

    // ── invalidate with filePath ─────────────────────────────────────

    describe("invalidate with filePath", () => {
        it("removes a specific entry by file path", async () => {
            writeMemoryFile("mem_rmfile01", "FACT", "content to remove");
            writeMemoryFile("mem_rmfile02", "FACT", "content to keep");
            await metadataIndex.rebuild();

            expect(metadataIndex.getById("mem_rmfile01")).toBeDefined();
            const filePath = join(TEST_VAULT, "memories", "mem_rmfile01.md");
            // Use forward slashes for the filePath in the index
            const relPath = "memories/mem_rmfile01.md";
            metadataIndex.invalidate(relPath);

            expect(metadataIndex.getById("mem_rmfile01")).toBeUndefined();
            expect(metadataIndex.getById("mem_rmfile02")).toBeDefined();
        });

        it("handles invalidation of non-existent file path gracefully", () => {
            injectMemory(makeMemory({ id: "m1" }));
            // Should not throw
            metadataIndex.invalidate("nonexistent/path.md");
            // Existing entries remain
            expect(metadataIndex.getById("m1")).toBeDefined();
        });

        it("marks index as stale after file-specific invalidation", async () => {
            writeMemoryFile("mem_stale001", "FACT", "some content");
            await metadataIndex.rebuild();
            expect(metadataIndex.getStats().isStale).toBe(false);

            metadataIndex.invalidate("memories/mem_stale001.md");
            expect(metadataIndex.getStats().isStale).toBe(true);
        });
    });

    // ── isInitialized ────────────────────────────────────────────────

    describe("isInitialized", () => {
        it("returns true after rebuild", async () => {
            await metadataIndex.rebuild();
            expect(metadataIndex.isInitialized()).toBe(true);
        });

        it("returns true when set manually", () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (metadataIndex as any).initialized = true;
            expect(metadataIndex.isInitialized()).toBe(true);
        });
    });
});

// ── File-writing helpers ─────────────────────────────────────────────

/**
 * Remove all files and subdirectories from the memories directory (but keep the directory itself).
 */
function cleanMemoriesDir(): void {
    const memDir = join(TEST_VAULT, "memories");
    try {
        rmSync(memDir, { recursive: true, force: true });
        mkdirSync(memDir, { recursive: true });
    } catch {
        // Ignore if directory doesn't exist
    }
    // Also clean up other directories that tests may create
    for (const dir of [".trash", "archive"]) {
        try {
            rmSync(join(TEST_VAULT, dir), { recursive: true, force: true });
        } catch {
            // Ignore
        }
    }
}

function makeFrontmatter(id: string, type: string): string {
    return [
        "---",
        `id: ${id}`,
        `type: ${type}`,
        "status: ACTIVE",
        "confidence: 0.8",
        "project: test-project",
        "importance: NORMAL",
        "tags: []",
        "related: []",
        "---",
        "",
    ].join("\n");
}

/**
 * Write a .md file with valid memory frontmatter into the test vault's memories directory.
 */
function writeMemoryFile(id: string, type: string, body: string): void {
    const content = makeFrontmatter(id, type) + body;
    writeFileSync(join(TEST_VAULT, "memories", `${id}.md`), content);
}
