/**
 * Unit tests for the append-only audit log.
 * Tests logging, querying, filtering, and rotation logic.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { logAuditEntry, queryAuditLog, getAuditEntriesForMemory, resetAuditCache } from "./audit-log.js";
import { initVault } from "./vault.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const TEST_VAULT = resolve(process.cwd(), ".test-vault-audit-log");

beforeAll(() => {
    rmSync(TEST_VAULT, { recursive: true, force: true });
    mkdirSync(TEST_VAULT, { recursive: true });
    // Create .quill directory for audit log
    mkdirSync(join(TEST_VAULT, ".quill"), { recursive: true });
    process.env.NOTES_VAULT_PATH = TEST_VAULT;
    initVault();
});

afterAll(() => {
    rmSync(TEST_VAULT, { recursive: true, force: true });
    delete process.env.NOTES_VAULT_PATH;
});

beforeEach(() => {
    resetAuditCache();
    // Clear audit file between tests
    const auditPath = join(TEST_VAULT, ".quill", "audit.json");
    writeFileSync(auditPath, "[]", "utf-8");
});

describe("Audit Log", () => {
    describe("logAuditEntry", () => {
        it("logs an entry with auto-generated timestamp", async () => {
            await logAuditEntry({
                actor: "agent",
                memoryId: "mem_001",
                action: "create",
                newState: { status: "ACTIVE" },
                reason: "Test creation",
            });

            const entries = await queryAuditLog({});
            expect(entries).toHaveLength(1);
            expect(entries[0].memoryId).toBe("mem_001");
            expect(entries[0].action).toBe("create");
            expect(entries[0].timestamp).toBeDefined();
            expect(entries[0].actor).toBe("agent");
        });

        it("appends multiple entries in order", async () => {
            await logAuditEntry({
                actor: "agent",
                memoryId: "mem_001",
                action: "create",
                newState: { status: "ACTIVE" },
            });
            // Space writes apart so timestamps differ beyond ms resolution
            await new Promise((resolve) => setTimeout(resolve, 2));
            await logAuditEntry({
                actor: "user",
                memoryId: "mem_002",
                action: "update",
                newState: { status: "CONFIRMED" },
            });

            const entries = await queryAuditLog({});
            expect(entries).toHaveLength(2);
            // Most recent first (sorted by timestamp descending)
            expect(entries[0].memoryId).toBe("mem_002");
            expect(entries[1].memoryId).toBe("mem_001");
        });

        it("includes previousState and newState", async () => {
            await logAuditEntry({
                actor: "system",
                memoryId: "mem_003",
                action: "status_change",
                previousState: { status: "ACTIVE" },
                newState: { status: "ARCHIVED" },
                reason: "Auto-archive",
            });

            const entries = await queryAuditLog({});
            expect(entries[0].previousState).toEqual({ status: "ACTIVE" });
            expect(entries[0].newState).toEqual({ status: "ARCHIVED" });
        });

        it("includes sessionId when provided", async () => {
            await logAuditEntry({
                actor: "agent",
                memoryId: "mem_004",
                action: "create",
                newState: { status: "ACTIVE" },
                sessionId: "session_abc123",
            });

            const entries = await queryAuditLog({});
            expect(entries[0].sessionId).toBe("session_abc123");
        });
    });

    describe("queryAuditLog", () => {
        beforeEach(async () => {
            // Seed test data; space writes apart so timestamps differ beyond ms resolution
            const tick = () => new Promise((resolve) => setTimeout(resolve, 2));
            await logAuditEntry({
                actor: "agent",
                memoryId: "mem_alpha",
                action: "create",
                newState: { status: "ACTIVE" },
            });
            await tick();
            await logAuditEntry({
                actor: "user",
                memoryId: "mem_beta",
                action: "update",
                newState: { confidence: 0.9 },
            });
            await tick();
            await logAuditEntry({
                actor: "agent",
                memoryId: "mem_alpha",
                action: "status_change",
                previousState: { status: "ACTIVE" },
                newState: { status: "CONFIRMED" },
            });
            await tick();
            await logAuditEntry({
                actor: "system",
                memoryId: "mem_gamma",
                action: "archive",
                newState: { status: "ARCHIVED" },
            });
        });

        it("returns all entries with empty filter", async () => {
            const entries = await queryAuditLog({});
            expect(entries).toHaveLength(4);
        });

        it("filters by memoryId", async () => {
            const entries = await queryAuditLog({ memoryId: "mem_alpha" });
            expect(entries).toHaveLength(2);
            expect(entries.every((e) => e.memoryId === "mem_alpha")).toBe(true);
        });

        it("filters by single action", async () => {
            const entries = await queryAuditLog({ action: "create" });
            expect(entries).toHaveLength(1);
            expect(entries[0].action).toBe("create");
        });

        it("filters by multiple actions", async () => {
            const entries = await queryAuditLog({ action: ["create", "archive"] });
            expect(entries).toHaveLength(2);
        });

        it("filters by actor", async () => {
            const entries = await queryAuditLog({ actor: "agent" });
            expect(entries).toHaveLength(2);
            expect(entries.every((e) => e.actor === "agent")).toBe(true);
        });

        it("applies limit", async () => {
            const entries = await queryAuditLog({ limit: 2 });
            expect(entries).toHaveLength(2);
        });

        it("returns most recent first", async () => {
            const entries = await queryAuditLog({});
            for (let i = 0; i < entries.length - 1; i++) {
                expect(entries[i].timestamp >= entries[i + 1].timestamp).toBe(true);
            }
        });

        it("filters by from timestamp", async () => {
            const allEntries = await queryAuditLog({});
            const midTimestamp = allEntries[1].timestamp;

            const entries = await queryAuditLog({ from: midTimestamp });
            // Should include entries at or after midTimestamp
            expect(entries.length).toBeLessThanOrEqual(2);
            expect(entries.every((e) => e.timestamp >= midTimestamp)).toBe(true);
        });

        it("filters by to timestamp", async () => {
            const allEntries = await queryAuditLog({});
            const midTimestamp = allEntries[1].timestamp;

            const entries = await queryAuditLog({ to: midTimestamp });
            // Should include entries at or before midTimestamp
            expect(entries.every((e) => e.timestamp <= midTimestamp)).toBe(true);
        });
    });

    describe("getAuditEntriesForMemory", () => {
        it("returns all entries for a specific memory", async () => {
            await logAuditEntry({
                actor: "agent",
                memoryId: "mem_target",
                action: "create",
                newState: { status: "ACTIVE" },
            });
            await logAuditEntry({
                actor: "user",
                memoryId: "mem_other",
                action: "update",
                newState: { confidence: 0.5 },
            });
            await logAuditEntry({
                actor: "agent",
                memoryId: "mem_target",
                action: "status_change",
                previousState: { status: "ACTIVE" },
                newState: { status: "CONFIRMED" },
            });

            const entries = await getAuditEntriesForMemory("mem_target");
            expect(entries).toHaveLength(2);
            expect(entries.every((e) => e.memoryId === "mem_target")).toBe(true);
        });

        it("returns empty array for unknown memory", async () => {
            const entries = await getAuditEntriesForMemory("mem_nonexistent");
            expect(entries).toEqual([]);
        });
    });
});
