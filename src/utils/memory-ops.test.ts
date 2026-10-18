/**
 * Tests for memory-ops utility module.
 * Tests CRUD operations, linking, supersession, and index integration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateMemoryId } from "./memory-id.js";

// Mock external dependencies
vi.mock("./vault.js", async () => {
    const actual = await vi.importActual<typeof import("./vault.js")>("./vault.js");
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
    };
});

vi.mock("./session-tracker.js", () => ({
    recordMutation: vi.fn(),
}));

vi.mock("./trash.js", () => ({
    moveToTrash: vi.fn().mockImplementation(async (p: string) => `${p}.trash`),
}));

vi.mock("./config.js", () => ({
    getConfig: () => ({
        memory: {
            enabled: true,
            directories: {
                memories: "memories",
                sessions: "sessions",
                state: "state",
                archive: "archive",
            },
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

// Import after mocks
import {
    createMemory,
    readMemory,
    updateMemory,
    deleteMemory,
    linkMemories,
    ensureIndexInitialized,
} from "./memory-ops.js";

const TEST_VAULT_ROOT = join(process.cwd(), ".test-memory-ops-vault");
const MEMORIES_DIR = join(TEST_VAULT_ROOT, "memories");

describe("memory-ops", () => {
    beforeEach(async () => {
        await mkdir(MEMORIES_DIR, { recursive: true });
    });

    afterEach(async () => {
        await rm(TEST_VAULT_ROOT, { recursive: true, force: true }).catch(() => {});
    });

    describe("createMemory", () => {
        it("should create a memory with auto-generated ID", async () => {
            const result = await createMemory({
                type: "FACT",
                project: "test-project",
                content: "This is a test fact.",
            });

            expect(result.frontmatter.id).toMatch(/^mem_/);
            expect(result.frontmatter.type).toBe("FACT");
            expect(result.frontmatter.project).toBe("test-project");
            expect(result.frontmatter.status).toBe("ACTIVE");
            expect(result.frontmatter.confidence).toBeGreaterThan(0);
            expect(result.content).toBe("This is a test fact.");
        });

        it("should create a memory with custom ID", async () => {
            const customId = generateMemoryId();
            const result = await createMemory({
                id: customId,
                type: "DECISION",
                project: "my-project",
                content: "We decided to use TypeScript.",
                importance: "HIGH",
                tags: ["typescript", "architecture"],
            });

            expect(result.frontmatter.id).toBe(customId);
            expect(result.frontmatter.type).toBe("DECISION");
            expect(result.frontmatter.importance).toBe("HIGH");
            expect(result.frontmatter.tags).toEqual(["typescript", "architecture"]);
        });

        it("should reject invalid custom ID", async () => {
            await expect(
                createMemory({
                    id: "bad-id",
                    type: "FACT",
                    project: "test",
                    content: "test",
                }),
            ).rejects.toThrow("Invalid memory ID format");
        });

        it("should reject duplicate ID", async () => {
            const id = generateMemoryId();
            await createMemory({ id, type: "FACT", project: "test", content: "first" });
            await expect(
                createMemory({ id, type: "FACT", project: "test", content: "second" }),
            ).rejects.toThrow("Memory already exists");
        });

        it("should write file to memories directory", async () => {
            const result = await createMemory({
                type: "LESSON",
                project: "test",
                content: "Always validate input.",
            });

            const filePath = join(MEMORIES_DIR, `${result.frontmatter.id}.md`);
            const fileContent = await readFile(filePath, "utf-8");
            expect(fileContent).toContain("type: LESSON");
            expect(fileContent).toContain("Always validate input.");
        });

        it("should set created and updated timestamps", async () => {
            const before = new Date().toISOString();
            const result = await createMemory({
                type: "FACT",
                project: "test",
                content: "test",
            });
            const after = new Date().toISOString();

            expect(result.frontmatter.created >= before).toBe(true);
            expect(result.frontmatter.created <= after).toBe(true);
            expect(result.frontmatter.updated >= before).toBe(true);
        });
    });

    describe("readMemory", () => {
        it("should read a created memory by ID", async () => {
            const created = await createMemory({
                type: "FACT",
                project: "test",
                content: "Test content for reading.",
                tags: ["read-test"],
            });

            const read = await readMemory(created.frontmatter.id);
            expect(read.frontmatter.id).toBe(created.frontmatter.id);
            expect(read.frontmatter.type).toBe("FACT");
            expect(read.content).toBe("Test content for reading.");
            expect(read.frontmatter.tags).toEqual(["read-test"]);
        });

        it("should throw for non-existent memory", async () => {
            await expect(readMemory("mem_00000000000000000000000000")).rejects.toThrow("Memory not found");
        });
    });

    describe("updateMemory", () => {
        it("should update content of existing memory", async () => {
            const created = await createMemory({
                type: "FACT",
                project: "test",
                content: "Original content.",
            });

            const updated = await updateMemory({
                id: created.frontmatter.id,
                content: "Updated content.",
            });

            expect(updated.content).toBe("Updated content.");
            expect(updated.frontmatter.id).toBe(created.frontmatter.id);
        });

        it("should update metadata fields", async () => {
            const created = await createMemory({
                type: "FACT",
                project: "test",
                content: "test",
            });

            const updated = await updateMemory({
                id: created.frontmatter.id,
                status: "CONFIRMED",
                confidence: 0.95,
                importance: "HIGH",
                tags: ["updated"],
            });

            expect(updated.frontmatter.status).toBe("CONFIRMED");
            expect(updated.frontmatter.confidence).toBe(0.95);
            expect(updated.frontmatter.importance).toBe("HIGH");
            expect(updated.frontmatter.tags).toEqual(["updated"]);
        });

        it("should update the updated timestamp", async () => {
            const created = await createMemory({
                type: "FACT",
                project: "test",
                content: "test",
            });

            // Small delay to ensure timestamp difference
            await new Promise((r) => setTimeout(r, 10));

            const updated = await updateMemory({
                id: created.frontmatter.id,
                content: "new content",
            });

            expect(updated.frontmatter.updated >= created.frontmatter.updated).toBe(true);
        });

        it("should throw for non-existent memory", async () => {
            await expect(
                updateMemory({ id: "mem_00000000000000000000000000", content: "test" }),
            ).rejects.toThrow("Memory not found");
        });
    });

    describe("deleteMemory", () => {
        it("should soft-delete a memory via moveToTrash", async () => {
            const created = await createMemory({
                type: "FACT",
                project: "test",
                content: "to be deleted",
            });

            const trashPath = await deleteMemory(created.frontmatter.id);
            expect(trashPath).toBeTruthy();
        });

        it("should throw for non-existent memory", async () => {
            await expect(deleteMemory("mem_00000000000000000000000000")).rejects.toThrow("Memory not found");
        });
    });

    describe("linkMemories", () => {
        it("should create bidirectional links", async () => {
            const mem1 = await createMemory({
                type: "FACT",
                project: "test",
                content: "First memory",
            });
            const mem2 = await createMemory({
                type: "FACT",
                project: "test",
                content: "Second memory",
            });

            const result = await linkMemories(mem1.frontmatter.id, mem2.frontmatter.id);

            expect(result.sourceRelated).toContain(mem2.frontmatter.id);
            expect(result.targetRelated).toContain(mem1.frontmatter.id);

            // Verify persisted
            const read1 = await readMemory(mem1.frontmatter.id);
            const read2 = await readMemory(mem2.frontmatter.id);
            expect(read1.frontmatter.related).toContain(mem2.frontmatter.id);
            expect(read2.frontmatter.related).toContain(mem1.frontmatter.id);
        });

        it("should not duplicate existing links", async () => {
            const mem1 = await createMemory({
                type: "FACT",
                project: "test",
                content: "First",
            });
            const mem2 = await createMemory({
                type: "FACT",
                project: "test",
                content: "Second",
            });

            await linkMemories(mem1.frontmatter.id, mem2.frontmatter.id);
            await linkMemories(mem1.frontmatter.id, mem2.frontmatter.id);

            const read1 = await readMemory(mem1.frontmatter.id);
            const count = read1.frontmatter.related.filter((id) => id === mem2.frontmatter.id).length;
            expect(count).toBe(1);
        });

        it("should reject self-linking", async () => {
            const mem = await createMemory({
                type: "FACT",
                project: "test",
                content: "Solo",
            });

            await expect(linkMemories(mem.frontmatter.id, mem.frontmatter.id)).rejects.toThrow(
                "Cannot link a memory to itself",
            );
        });
    });

    describe("supersession", () => {
        it("should mark old memory as SUPERSEDED when creating with supersedes", async () => {
            const old = await createMemory({
                type: "FACT",
                project: "test",
                content: "Old fact",
            });

            const replacement = await createMemory({
                type: "FACT",
                project: "test",
                content: "New fact",
                supersedes: old.frontmatter.id,
            });

            const readOld = await readMemory(old.frontmatter.id);
            expect(readOld.frontmatter.status).toBe("SUPERSEDED");
            expect(readOld.frontmatter.superseded_by).toBe(replacement.frontmatter.id);

            expect(replacement.frontmatter.supersedes).toBe(old.frontmatter.id);
        });
    });

    describe("ensureIndexInitialized", () => {
        it("should not throw", async () => {
            await expect(ensureIndexInitialized()).resolves.not.toThrow();
        });
    });
});
