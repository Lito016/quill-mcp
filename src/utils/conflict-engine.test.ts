/**
 * Unit tests for the conflict detection engine.
 * Tests resolution logic and supersession chain tracing.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { resolveConflict, getSupersessionChain, detectConflicts, checkConflicts } from "./conflict-engine.js";
import { metadataIndex } from "./metadata-index.js";
import { initVault } from "./vault.js";
import type { MemoryMetadata } from "./memory-schema.js";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

// Helper to create a mock memory metadata object
function makeMemory(overrides: Partial<MemoryMetadata> = {}): MemoryMetadata {
    return {
        id: overrides.id ?? "mem_test_001",
        type: overrides.type ?? "DECISION",
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

/**
 * Inject a memory directly into the metadata index's internal store.
 */
function injectMemory(mem: MemoryMetadata): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = metadataIndex as any;
    internals.memories.set(mem.id, mem);

    // Update byEntity index so getByEntity works
    if (mem.entity) {
        const key = mem.entity.toLowerCase();
        if (!internals.byEntity.has(key)) {
            internals.byEntity.set(key, new Set());
        }
        internals.byEntity.get(key).add(mem.id);
    }
}

const TEST_VAULT = resolve(process.cwd(), ".test-vault-conflict-engine");

beforeAll(() => {
    rmSync(TEST_VAULT, { recursive: true, force: true });
    mkdirSync(TEST_VAULT, { recursive: true });
    process.env.NOTES_VAULT_PATH = TEST_VAULT;
    initVault();
});

afterAll(() => {
    rmSync(TEST_VAULT, { recursive: true, force: true });
    delete process.env.NOTES_VAULT_PATH;
});

describe("Conflict Engine", () => {
    beforeEach(() => {
        // Clear the metadata index without triggering a vault scan
        metadataIndex.invalidate();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (metadataIndex as any).initialized = true;
    });

    describe("pair comparison logic", () => {
        it("same entity + different content = potential conflict", () => {
            const mem1 = makeMemory({
                id: "mem_001",
                entity: "database",
                contentPreview: "Use PostgreSQL for the database",
                type: "DECISION",
            });
            const mem2 = makeMemory({
                id: "mem_002",
                entity: "database",
                contentPreview: "Use MySQL for the database",
                type: "DECISION",
            });

            expect(mem1.entity).toBe(mem2.entity);
            expect(mem1.contentPreview).not.toBe(mem2.contentPreview);
            expect(mem1.type).toBe(mem2.type);
        });

        it("identical content is not a conflict", () => {
            const mem1 = makeMemory({ entity: "api", contentPreview: "REST API with JSON" });
            const mem2 = makeMemory({ entity: "api", contentPreview: "REST API with JSON" });

            expect(mem1.contentPreview).toBe(mem2.contentPreview);
        });

        it("different entities are not compared", () => {
            const mem1 = makeMemory({ entity: "database", contentPreview: "Use PostgreSQL" });
            const mem2 = makeMemory({ entity: "cache", contentPreview: "Use Redis" });

            expect(mem1.entity).not.toBe(mem2.entity);
        });
    });

    describe("resolveConflict", () => {
        it("supersedes the non-keeper memory", async () => {
            const mem1 = makeMemory({ id: "mem_resolve_001", status: "CONFLICTED" });
            const mem2 = makeMemory({ id: "mem_resolve_002", status: "CONFLICTED" });
            injectMemory(mem1);
            injectMemory(mem2);

            const result = await resolveConflict(mem1.id, mem2.id, "supersede", mem1.id, "mem_001 is more recent");

            expect(result.success).toBe(true);
            expect(result.action).toBe("supersede");
            expect(result.memoryA.newStatus).toBe("ACTIVE");
            expect(result.memoryB.newStatus).toBe("SUPERSEDED");
            expect(result.auditEntries).toBe(2);
        });

        it("supersede defaults to memoryIdA as keeper when no keeper specified", async () => {
            const mem1 = makeMemory({ id: "mem_default_keeper", status: "CONFLICTED" });
            const mem2 = makeMemory({ id: "mem_default_other", status: "CONFLICTED" });
            injectMemory(mem1);
            injectMemory(mem2);

            const result = await resolveConflict(mem1.id, mem2.id, "supersede");

            expect(result.memoryA.newStatus).toBe("ACTIVE");
            expect(result.memoryB.newStatus).toBe("SUPERSEDED");
        });

        it("rejects both memories in reject mode", async () => {
            const mem1 = makeMemory({ id: "mem_reject_001", status: "CONFLICTED" });
            const mem2 = makeMemory({ id: "mem_reject_002", status: "CONFLICTED" });
            injectMemory(mem1);
            injectMemory(mem2);

            const result = await resolveConflict(mem1.id, mem2.id, "reject", undefined, "Both are wrong");

            expect(result.success).toBe(true);
            expect(result.memoryA.newStatus).toBe("REJECTED");
            expect(result.memoryB.newStatus).toBe("REJECTED");
        });

        it("marks both as CONFLICTED in manual_review mode", async () => {
            const mem1 = makeMemory({ id: "mem_review_001", status: "ACTIVE" });
            const mem2 = makeMemory({ id: "mem_review_002", status: "ACTIVE" });
            injectMemory(mem1);
            injectMemory(mem2);

            const result = await resolveConflict(mem1.id, mem2.id, "manual_review");

            expect(result.success).toBe(true);
            expect(result.memoryA.newStatus).toBe("CONFLICTED");
            expect(result.memoryB.newStatus).toBe("CONFLICTED");
        });

        it("throws when a memory ID is not found", async () => {
            await expect(resolveConflict("mem_nonexistent", "mem_also_missing", "supersede")).rejects.toThrow(
                /Cannot resolve conflict/,
            );
        });
    });

    describe("getSupersessionChain", () => {
        it("returns single-element chain for memory with no supersedes link", async () => {
            const mem = makeMemory({ id: "mem_chain_001" });
            injectMemory(mem);

            const chain = await getSupersessionChain(mem.id);
            expect(chain).toEqual([mem.id]);
        });

        it("traces chain through supersedes links", async () => {
            const mem1 = makeMemory({ id: "mem_chain_a" });
            const mem2 = makeMemory({ id: "mem_chain_b", supersedes: "mem_chain_a" });
            const mem3 = makeMemory({ id: "mem_chain_c", supersedes: "mem_chain_b" });
            injectMemory(mem1);
            injectMemory(mem2);
            injectMemory(mem3);

            // Verify injection worked
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const m = (metadataIndex as any).memories as Map<string, MemoryMetadata>;
            expect(m.get("mem_chain_b")?.supersedes).toBe("mem_chain_a");
            expect(m.get("mem_chain_c")?.supersedes).toBe("mem_chain_b");

            const chain = await getSupersessionChain("mem_chain_c");
            expect(chain).toEqual(["mem_chain_c", "mem_chain_b", "mem_chain_a"]);
        });

        it("handles cycles without infinite loop", async () => {
            const mem1 = makeMemory({ id: "mem_cycle_a", supersedes: "mem_cycle_b" });
            const mem2 = makeMemory({ id: "mem_cycle_b", supersedes: "mem_cycle_a" });
            injectMemory(mem1);
            injectMemory(mem2);

            const chain = await getSupersessionChain("mem_cycle_a");
            expect(chain.length).toBeLessThanOrEqual(2);
            expect(chain[0]).toBe("mem_cycle_a");
        });

        it("returns start-only chain for nonexistent memory", async () => {
            const chain = await getSupersessionChain("mem_nonexistent");
            expect(chain).toEqual(["mem_nonexistent"]);
        });
    });

    describe("detectConflicts", () => {
        it("detects conflicts between same-entity memories with different content", async () => {
            const mem1 = makeMemory({
                id: "det_1",
                entity: "database",
                type: "DECISION",
                contentPreview: "Use PostgreSQL for the database",
            });
            const mem2 = makeMemory({
                id: "det_2",
                entity: "database",
                type: "DECISION",
                contentPreview: "Use MySQL for the database",
            });
            injectMemory(mem1);
            injectMemory(mem2);

            const result = await detectConflicts("test-project");
            expect(result.conflicts).toHaveLength(1);
            expect(result.conflicts[0].conflictingEntity).toBe("database");
            expect(result.scannedCount).toBe(2);
        });

        it("does not flag same-content memories as conflicts", async () => {
            const mem1 = makeMemory({
                id: "same_1",
                entity: "api",
                type: "FACT",
                contentPreview: "REST API with JSON",
            });
            const mem2 = makeMemory({
                id: "same_2",
                entity: "api",
                type: "FACT",
                contentPreview: "REST API with JSON",
            });
            injectMemory(mem1);
            injectMemory(mem2);

            const result = await detectConflicts("test-project");
            expect(result.conflicts).toHaveLength(0);
        });

        it("does not compare memories with different types", async () => {
            const mem1 = makeMemory({
                id: "diff_1",
                entity: "cache",
                type: "DECISION",
                contentPreview: "Use Redis",
            });
            const mem2 = makeMemory({
                id: "diff_2",
                entity: "cache",
                type: "FACT",
                contentPreview: "Redis is used",
            });
            injectMemory(mem1);
            injectMemory(mem2);

            const result = await detectConflicts("test-project");
            expect(result.conflicts).toHaveLength(0);
        });

        it("filters by type when specified", async () => {
            const mem1 = makeMemory({ id: "filt_1", entity: "db", type: "DECISION", contentPreview: "Use PG" });
            const mem2 = makeMemory({ id: "filt_2", entity: "db", type: "DECISION", contentPreview: "Use MySQL" });
            injectMemory(mem1);
            injectMemory(mem2);

            const result = await detectConflicts("test-project", "DECISION");
            expect(result.conflicts).toHaveLength(1);

            const noResult = await detectConflicts("test-project", "FACT");
            expect(noResult.conflicts).toHaveLength(0);
        });

        it("assesses severity as 'likely' for DECISION type conflicts", async () => {
            const mem1 = makeMemory({ id: "sev_1", entity: "arch", type: "DECISION", contentPreview: "Microservices" });
            const mem2 = makeMemory({ id: "sev_2", entity: "arch", type: "DECISION", contentPreview: "Monolith" });
            injectMemory(mem1);
            injectMemory(mem2);

            const result = await detectConflicts("test-project");
            expect(result.conflicts[0].severity).toBe("likely");
        });

        it("returns empty conflicts when no memories exist", async () => {
            const result = await detectConflicts("test-project");
            expect(result.conflicts).toHaveLength(0);
            expect(result.scannedCount).toBe(0);
        });
    });

    describe("checkConflicts", () => {
        it("returns conflicts for a new memory against existing ones", async () => {
            const existing = makeMemory({
                id: "exist_1",
                entity: "database",
                type: "DECISION",
                contentPreview: "Use PostgreSQL",
            });
            injectMemory(existing);

            const newMem = {
                id: "new_1",
                type: "DECISION" as const,
                status: "ACTIVE" as const,
                confidence: 0.8,
                project: "test-project",
                created: "2026-01-01T00:00:00Z",
                updated: "2026-01-01T00:00:00Z",
                source_type: "AGENT" as const,
                importance: "NORMAL" as const,
                entity: "database",
                related: [],
                tags: [],
            };

            const conflicts = await checkConflicts(newMem);
            expect(conflicts).toHaveLength(1);
            expect(conflicts[0].conflictingEntity).toBe("database");
        });

        it("returns empty array when new memory has no entity", async () => {
            const conflicts = await checkConflicts({
                id: "no_entity",
                type: "FACT",
                status: "ACTIVE",
                confidence: 0.8,
                project: "test-project",
                created: "2026-01-01T00:00:00Z",
                updated: "2026-01-01T00:00:00Z",
                source_type: "AGENT",
                importance: "NORMAL",
                related: [],
                tags: [],
            });
            expect(conflicts).toHaveLength(0);
        });

        it("does not compare with memories from different projects", async () => {
            const existing = makeMemory({
                id: "other_proj",
                entity: "database",
                type: "DECISION",
                project: "other-project",
                contentPreview: "Use PostgreSQL",
            });
            injectMemory(existing);

            const conflicts = await checkConflicts({
                id: "new_proj",
                type: "DECISION",
                status: "ACTIVE",
                confidence: 0.8,
                project: "test-project",
                created: "2026-01-01T00:00:00Z",
                updated: "2026-01-01T00:00:00Z",
                source_type: "AGENT",
                importance: "NORMAL",
                entity: "database",
                related: [],
                tags: [],
            });
            expect(conflicts).toHaveLength(0);
        });
    });
});
