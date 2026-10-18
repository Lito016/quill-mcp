import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { jaccardSimilarity, normalizeToTokens, consolidate } from "./consolidation.js";
import { metadataIndex } from "./metadata-index.js";
import { initVault } from "./vault.js";
import type { MemoryMetadata } from "./memory-schema.js";
import { mkdirSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";

describe("Consolidation", () => {
    describe("jaccardSimilarity", () => {
        it("should return 1 for identical sets", () => {
            const a = new Set(["hello", "world"]);
            expect(jaccardSimilarity(a, a)).toBe(1);
        });

        it("should return 1 for two empty sets", () => {
            expect(jaccardSimilarity(new Set(), new Set())).toBe(1);
        });

        it("should return 0 for completely disjoint sets", () => {
            const a = new Set(["a", "b"]);
            const b = new Set(["c", "d"]);
            expect(jaccardSimilarity(a, b)).toBe(0);
        });

        it("should return 0.5 for half overlap", () => {
            const a = new Set(["a", "b"]);
            const b = new Set(["b", "c"]);
            expect(jaccardSimilarity(a, b)).toBeCloseTo(1 / 3, 2);
        });

        it("should handle one empty set", () => {
            const a = new Set(["a"]);
            expect(jaccardSimilarity(a, new Set())).toBe(0);
        });

        it("should handle subset relationship", () => {
            const a = new Set(["a", "b", "c"]);
            const b = new Set(["a"]);
            // intersection = 1, union = 3, jaccard = 1/3
            expect(jaccardSimilarity(a, b)).toBeCloseTo(1 / 3, 2);
        });
    });

    describe("normalizeToTokens", () => {
        it("strips stopwords and lowercases", () => {
            const tokens = normalizeToTokens("The quick brown fox is a fast animal");
            expect(tokens.has("the")).toBe(false);
            expect(tokens.has("is")).toBe(false);
            expect(tokens.has("a")).toBe(false);
            expect(tokens.has("quick")).toBe(true);
            expect(tokens.has("brown")).toBe(true);
            expect(tokens.has("fox")).toBe(true);
        });

        it("generates bigrams for phrase detection", () => {
            const tokens = normalizeToTokens("database connection pool");
            expect(tokens.has("database connection")).toBe(true);
            expect(tokens.has("connection pool")).toBe(true);
            expect(tokens.has("database")).toBe(true);
            expect(tokens.has("pool")).toBe(true);
        });

        it("strips markdown syntax", () => {
            const tokens = normalizeToTokens("# Heading\n**bold** text\n- list item\n`code`");
            expect(tokens.has("heading")).toBe(true);
            expect(tokens.has("bold")).toBe(true);
            expect(tokens.has("text")).toBe(true);
            expect(tokens.has("list")).toBe(true);
            expect(tokens.has("item")).toBe(true);
            // "code" is stripped by the inline-code regex (`...`)
            expect(tokens.has("code")).toBe(false);
        });

        it("strips frontmatter markers", () => {
            const tokens = normalizeToTokens("---\ntitle: Test\ntags: [a, b]\n---\nContent here");
            expect(tokens.has("title")).toBe(false);
            expect(tokens.has("content")).toBe(true);
            // "here" is a stopword
            expect(tokens.has("here")).toBe(false);
        });

        it("strips code blocks", () => {
            const tokens = normalizeToTokens("Before\n```ts\nconst x = 1;\n```\nAfter");
            // "before" and "after" are stopwords
            expect(tokens.has("before")).toBe(false);
            expect(tokens.has("after")).toBe(false);
            expect(tokens.has("const")).toBe(false);
        });

        it("produces similar tokens for semantically equivalent text", () => {
            const a = normalizeToTokens("The database uses PostgreSQL for storage");
            const b = normalizeToTokens("PostgreSQL is used by the database for storage");
            // Both should share key terms and bigrams will differ due to word order
            expect(a.has("database")).toBe(true);
            expect(b.has("database")).toBe(true);
            expect(a.has("postgresql")).toBe(true);
            expect(b.has("postgresql")).toBe(true);
            expect(a.has("storage")).toBe(true);
            expect(b.has("storage")).toBe(true);
        });

        it("returns empty set for stopword-only text", () => {
            const tokens = normalizeToTokens("the a an is are was were");
            expect(tokens.size).toBe(0);
        });

        it("filters single-character tokens", () => {
            const tokens = normalizeToTokens("I a b c hello");
            expect(tokens.has("i")).toBe(false);
            expect(tokens.has("a")).toBe(false);
            expect(tokens.has("b")).toBe(false);
            expect(tokens.has("hello")).toBe(true);
        });
    });
});

// ── consolidate() integration tests ──────────────────────────────────

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
    const projectKey = mem.project.toLowerCase();
    if (!internals.byProject.has(projectKey)) internals.byProject.set(projectKey, new Set());
    internals.byProject.get(projectKey).add(mem.id);
    if (!internals.byType.has(mem.type)) internals.byType.set(mem.type, new Set());
    internals.byType.get(mem.type).add(mem.id);
    if (!internals.byStatus.has(mem.status)) internals.byStatus.set(mem.status, new Set());
    internals.byStatus.get(mem.status).add(mem.id);
}

const TEST_VAULT = resolve(process.cwd(), ".test-vault-consolidation");

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

describe("consolidate", () => {
    beforeEach(() => {
        metadataIndex.invalidate();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (metadataIndex as any).initialized = true;
    });

    describe("merge_duplicates", () => {
        it("detects near-duplicate memories by content similarity", async () => {
            const sharedContent = "Use PostgreSQL for the primary database with connection pooling";
            injectMemory(makeMemory({ id: "dup_1", project: "proj", type: "DECISION", contentPreview: sharedContent }));
            injectMemory(makeMemory({ id: "dup_2", project: "proj", type: "DECISION", contentPreview: sharedContent + " and caching layer" }));

            const result = await consolidate({ project: "proj", action: "merge_duplicates" });
            expect(result.candidatesFound).toBeGreaterThanOrEqual(1);
            expect(result.suggestions.length).toBeGreaterThanOrEqual(1);
        });

        it("does not flag memories with different content as duplicates", async () => {
            injectMemory(makeMemory({ id: "unique_1", project: "proj", type: "FACT", contentPreview: "PostgreSQL for database" }));
            injectMemory(makeMemory({ id: "unique_2", project: "proj", type: "FACT", contentPreview: "Redis for caching layer" }));

            const result = await consolidate({ project: "proj", action: "merge_duplicates" });
            expect(result.candidatesFound).toBe(0);
        });

        it("only compares memories of the same type", async () => {
            const content = "Use PostgreSQL for storage";
            injectMemory(makeMemory({ id: "diff_type_1", project: "proj", type: "DECISION", contentPreview: content }));
            injectMemory(makeMemory({ id: "diff_type_2", project: "proj", type: "FACT", contentPreview: content }));

            const result = await consolidate({ project: "proj", action: "merge_duplicates" });
            expect(result.candidatesFound).toBe(0);
        });
    });

    describe("promote_important", () => {
        it("suggests promotion for highly-referenced NORMAL memories", async () => {
            // Create a memory that is referenced by many others
            injectMemory(makeMemory({ id: "hub_mem", project: "proj", importance: "NORMAL", confidence: 0.9 }));
            for (let i = 0; i < 5; i++) {
                injectMemory(makeMemory({
                    id: `ref_${i}`,
                    project: "proj",
                    related: ["hub_mem"],
                    confidence: 0.8,
                }));
            }

            const result = await consolidate({ project: "proj", action: "promote_important" });
            expect(result.candidatesFound).toBeGreaterThanOrEqual(1);
            const suggestion = result.suggestions.find((s) => s.memoryId === "hub_mem");
            expect(suggestion).toBeDefined();
            expect(suggestion!.type).toBe("promote");
            expect(suggestion!.suggestedImportance).toBe("HIGH");
        });

        it("does not promote memories with too few references", async () => {
            injectMemory(makeMemory({ id: "lonely", project: "proj", importance: "NORMAL", confidence: 0.9 }));
            injectMemory(makeMemory({ id: "other", project: "proj", confidence: 0.8 }));

            const result = await consolidate({ project: "proj", action: "promote_important" });
            expect(result.suggestions.find((s) => s.memoryId === "lonely")).toBeUndefined();
        });
    });

    describe("archive_obsolete", () => {
        it("suggests archival for low-confidence memories", async () => {
            injectMemory(makeMemory({ id: "low_conf", project: "proj", confidence: 0.1 }));
            injectMemory(makeMemory({ id: "high_conf", project: "proj", confidence: 0.9 }));

            const result = await consolidate({ project: "proj", action: "archive_obsolete" });
            expect(result.suggestions.some((s) => s.memoryId === "low_conf")).toBe(true);
            expect(result.suggestions.some((s) => s.memoryId === "high_conf")).toBe(false);
        });

        it("suggests archival for stale memories", async () => {
            injectMemory(makeMemory({
                id: "stale",
                project: "proj",
                confidence: 0.8,
                updated: "2020-01-01T00:00:00Z", // very old
            }));
            injectMemory(makeMemory({
                id: "fresh",
                project: "proj",
                confidence: 0.8,
                updated: new Date().toISOString(), // today
            }));

            const result = await consolidate({ project: "proj", action: "archive_obsolete" });
            expect(result.suggestions.some((s) => s.memoryId === "stale")).toBe(true);
        });
    });
});
