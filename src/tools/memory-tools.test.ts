/**
 * Tests for memory file tools: read_memory, write_memory, list_memories,
 * search_memories, delete_memory, link_memories.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { generateMemoryId } from "../utils/memory-id.js";

// --- Mocks ---

const TEST_VAULT_ROOT = join(process.cwd(), ".test-memory-tools-vault");
const MEMORIES_DIR = join(TEST_VAULT_ROOT, "memories");

vi.mock("../utils/vault.js", async () => {
    const actual = await vi.importActual<typeof import("../utils/vault.js")>("../utils/vault.js");
    return {
        ...actual,
        getVaultRoot: () => TEST_VAULT_ROOT,
        pathExists: async (p: string) => {
            try {
                const { stat } = await import("node:fs/promises");
                await stat(p);
                return true;
            } catch {
                return false;
            }
        },
        invalidateReadCache: () => {},
        resolveVaultPath: (p: string) => join(TEST_VAULT_ROOT, p),
    };
});

vi.mock("../utils/session-tracker.js", () => ({
    recordMutation: vi.fn(),
}));

vi.mock("../utils/trash.js", () => ({
    moveToTrash: vi.fn().mockImplementation(async (p: string) => `${p}.trash`),
}));

vi.mock("../utils/config.js", () => ({
    getConfig: () => ({
        memory: {
            enabled: true,
            directories: { memories: "memories", sessions: "sessions", state: "state", archive: "archive" },
            typeDirs: {},
        },
        ranking: {
            projectBoost: 2.0,
            projectMissPenalty: 0.1,
            importanceWeights: { CRITICAL: 2.0, HIGH: 1.5, NORMAL: 1.0, LOW: 0.5, EPHEMERAL: 0.1 },
            recencyLambda: 0.01,
            archivedPenalty: 0.5,
            conflictPenalty: 0.3,
            graphBoostFactor: 0.2,
            bm25: { k1: 1.2, b: 0.75 },
        },
        consolidation: {
            jaccardThreshold: 0.7,
            staleDays: 30,
            lowConfidenceThreshold: 0.3,
            promotionReferenceThreshold: 3,
            promotionConfidenceThreshold: 0.9,
        },
        audit: { maxFileSizeMb: 10, rotationEnabled: true },
        guide: {},
    }),
    resetConfig: () => {},
}));

// Import tools after mocks
import { handler as writeMemoryHandler } from "../tools/write-memory.js";
import { handler as readMemoryHandler } from "../tools/read-memory.js";
import { handler as listMemoriesHandler } from "../tools/list-memories.js";
import { handler as searchMemoriesHandler } from "../tools/search-memories.js";
import { handler as deleteMemoryHandler } from "../tools/delete-memory.js";
import { handler as linkMemoriesHandler } from "../tools/link-memories.js";

// Helpers
function extractText(result: { content: Array<{ text: string }> }): string {
    return result.content.map((c) => c.text).join("\n");
}

describe("Memory Tools", () => {
    beforeEach(async () => {
        await mkdir(MEMORIES_DIR, { recursive: true });
    });

    afterEach(async () => {
        await rm(TEST_VAULT_ROOT, { recursive: true, force: true }).catch(() => {});
    });

    describe("write_memory (create)", () => {
        it("should create a new memory and return its ID", async () => {
            const result = await writeMemoryHandler({
                type: "FACT",
                project: "test-project",
                content: "TypeScript is great for large codebases.",
            });

            const text = extractText(result);
            expect(text).toContain("Memory created:");
            expect(text).toContain("mem_");
            expect(text).toContain("FACT");
            expect(text).toContain("test-project");
        });

        it("should create a memory with all optional fields", async () => {
            const result = await writeMemoryHandler({
                type: "DECISION",
                project: "my-app",
                content: "We chose React over Vue.",
                confidence: 0.9,
                source_type: "USER",
                importance: "HIGH",
                entity: "frontend-framework",
                tags: ["react", "vue", "frontend"],
            });

            const text = extractText(result);
            expect(text).toContain("Memory created:");
            expect(text).toContain("DECISION");
        });

        it("should return error for invalid ID format", async () => {
            const result = await writeMemoryHandler({
                id: "bad-id",
                type: "FACT",
                project: "test",
                content: "test",
            });

            expect(result.isError).toBe(true);
            expect(extractText(result)).toContain("Invalid memory ID format");
        });
    });

    describe("write_memory (update)", () => {
        it("should update an existing memory", async () => {
            // Create first
            const createResult = await writeMemoryHandler({
                type: "FACT",
                project: "test",
                content: "Original content.",
            });
            const id = extractText(createResult).match(/mem_[A-Z0-9]{26}/)?.[0];
            expect(id).toBeTruthy();

            // Update
            const updateResult = await writeMemoryHandler({
                id,
                type: "FACT",
                project: "test",
                content: "Updated content.",
                status: "CONFIRMED",
            });

            const text = extractText(updateResult);
            expect(text).toContain("Memory updated:");
            expect(text).toContain(id!);
        });
    });

    describe("read_memory", () => {
        it("should read a memory by ID", async () => {
            // Create
            const createResult = await writeMemoryHandler({
                type: "LESSON",
                project: "test",
                content: "Always write tests first.",
                tags: ["tdd", "testing"],
            });
            const id = extractText(createResult).match(/mem_[A-Z0-9]{26}/)?.[0];

            // Read
            const readResult = await readMemoryHandler({ id: id! });
            const text = extractText(readResult);

            expect(text).toContain(id!);
            expect(text).toContain("LESSON");
            expect(text).toContain("Always write tests first.");
            expect(text).toContain("tdd");
        });

        it("should return error for non-existent memory", async () => {
            const result = await readMemoryHandler({ id: "mem_00000000000000000000000000" });
            expect(result.isError).toBe(true);
            expect(extractText(result)).toContain("Memory not found");
        });
    });

    describe("list_memories", () => {
        it("should list all memories", async () => {
            await writeMemoryHandler({ type: "FACT", project: "proj-a", content: "Fact one" });
            await writeMemoryHandler({ type: "DECISION", project: "proj-b", content: "Decision one" });

            const result = await listMemoriesHandler({
                offset: 0,
                sort: "updated_desc",
            });

            const text = extractText(result);
            expect(text).toContain("Found");
            expect(text).toContain("proj-a");
            expect(text).toContain("proj-b");
        });

        it("should filter by project", async () => {
            await writeMemoryHandler({ type: "FACT", project: "proj-a", content: "A fact" });
            await writeMemoryHandler({ type: "FACT", project: "proj-b", content: "B fact" });

            const result = await listMemoriesHandler({
                project: "proj-a",
                offset: 0,
                sort: "updated_desc",
            });

            const text = extractText(result);
            expect(text).toContain("proj-a");
            expect(text).not.toContain("proj-b");
        });

        it("should filter by type", async () => {
            await writeMemoryHandler({ type: "FACT", project: "test", content: "A fact" });
            await writeMemoryHandler({ type: "LESSON", project: "test", content: "A lesson" });

            const result = await listMemoriesHandler({
                type: "LESSON",
                offset: 0,
                sort: "updated_desc",
            });

            const text = extractText(result);
            expect(text).toContain("LESSON");
        });

        it("should return empty message when no matches", async () => {
            const result = await listMemoriesHandler({
                project: "nonexistent",
                offset: 0,
                sort: "updated_desc",
            });

            expect(extractText(result)).toContain("No memories found");
        });
    });

    describe("search_memories", () => {
        it("should search memories by content", async () => {
            await writeMemoryHandler({
                type: "FACT",
                project: "test",
                content: "TypeScript provides excellent type safety for large applications.",
            });
            await writeMemoryHandler({
                type: "FACT",
                project: "test",
                content: "Python is great for data science and machine learning.",
            });

            const result = await searchMemoriesHandler({
                query: "TypeScript type safety",
                offset: 0,
            });

            const text = extractText(result);
            expect(text).toContain("Found");
            expect(text).toContain("TypeScript");
        });

        it("should return no results message for unmatched query", async () => {
            await writeMemoryHandler({
                type: "FACT",
                project: "test",
                content: "Some content here.",
            });

            const result = await searchMemoriesHandler({
                query: "xyznonexistent",
                offset: 0,
            });

            expect(extractText(result)).toContain("No memories found");
        });
    });

    describe("delete_memory", () => {
        it("should soft-delete a memory", async () => {
            const createResult = await writeMemoryHandler({
                type: "FACT",
                project: "test",
                content: "To be deleted.",
            });
            const id = extractText(createResult).match(/mem_[A-Z0-9]{26}/)?.[0];

            const result = await deleteMemoryHandler({ id: id!, dry_run: false });
            const text = extractText(result);
            expect(text).toContain("Memory deleted:");
            expect(text).toContain(id!);
        });

        it("should support dry run", async () => {
            const createResult = await writeMemoryHandler({
                type: "FACT",
                project: "test",
                content: "Not really deleted.",
            });
            const id = extractText(createResult).match(/mem_[A-Z0-9]{26}/)?.[0];

            const result = await deleteMemoryHandler({ id: id!, dry_run: true });
            const text = extractText(result);
            expect(text).toContain("[DRY RUN]");
        });

        it("should return error for non-existent memory", async () => {
            const result = await deleteMemoryHandler({
                id: "mem_00000000000000000000000000",
                dry_run: false,
            });
            expect(result.isError).toBe(true);
        });
    });

    describe("link_memories", () => {
        it("should create bidirectional links", async () => {
            const r1 = await writeMemoryHandler({ type: "FACT", project: "test", content: "First" });
            const r2 = await writeMemoryHandler({ type: "FACT", project: "test", content: "Second" });
            const id1 = extractText(r1).match(/mem_[A-Z0-9]{26}/)?.[0];
            const id2 = extractText(r2).match(/mem_[A-Z0-9]{26}/)?.[0];

            const result = await linkMemoriesHandler({
                source_id: id1!,
                target_id: id2!,
                relationship: "related",
            });

            const text = extractText(result);
            expect(text).toContain("linked bidirectionally");
            expect(text).toContain(id1!);
            expect(text).toContain(id2!);
        });

        it("should handle supersedes relationship", async () => {
            const r1 = await writeMemoryHandler({ type: "FACT", project: "test", content: "Old" });
            const r2 = await writeMemoryHandler({ type: "FACT", project: "test", content: "New" });
            const oldId = extractText(r1).match(/mem_[A-Z0-9]{26}/)?.[0];
            const newId = extractText(r2).match(/mem_[A-Z0-9]{26}/)?.[0];

            const result = await linkMemoriesHandler({
                source_id: newId!,
                target_id: oldId!,
                relationship: "supersedes",
            });

            const text = extractText(result);
            expect(text).toContain("supersedes");
            expect(text).toContain("SUPERSEDED");
        });

        it("should reject self-linking", async () => {
            const r1 = await writeMemoryHandler({ type: "FACT", project: "test", content: "Solo" });
            const id = extractText(r1).match(/mem_[A-Z0-9]{26}/)?.[0];

            const result = await linkMemoriesHandler({
                source_id: id!,
                target_id: id!,
                relationship: "related",
            });

            expect(result.isError).toBe(true);
            expect(extractText(result)).toContain("Cannot link a memory to itself");
        });
    });
});
