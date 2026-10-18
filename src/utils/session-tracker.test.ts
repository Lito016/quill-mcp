/**
 * Unit tests for session tracking.
 * Covers session lifecycle (start/end), mutation recording, history, and summary computation.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
    startSession,
    endSession,
    recordMutation,
    getCurrentSessionId,
    getSessions,
    getSession,
} from "./session-tracker.js";
import { initVault } from "./vault.js";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const TEST_VAULT = resolve(process.cwd(), ".test-vault-session-tracker");

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

describe("Session Tracker", () => {
    beforeEach(async () => {
        // End any active session before each test
        await endSession();
    });

    describe("startSession", () => {
        it("returns a session ID starting with 'session-'", async () => {
            const id = await startSession();
            expect(id).toMatch(/^session-/);
        });

        it("sets the current session ID", async () => {
            const id = await startSession();
            expect(getCurrentSessionId()).toBe(id);
        });

        it("ends the previous session when starting a new one", async () => {
            const first = await startSession();
            await recordMutation({ type: "create", path: "test.md" });
            const second = await startSession();

            expect(second).not.toBe(first);
            expect(getCurrentSessionId()).toBe(second);

            // First session should be ended with a summary
            const firstRecord = await getSession(first);
            expect(firstRecord?.endedAt).toBeDefined();
            expect(firstRecord?.summary).toBeDefined();
        });
    });

    describe("recordMutation", () => {
        it("auto-starts a session if none is active", async () => {
            expect(getCurrentSessionId()).toBeUndefined();
            await recordMutation({ type: "create", path: "auto.md" });
            expect(getCurrentSessionId()).toBeDefined();
        });

        it("records mutations in the current session", async () => {
            const id = await startSession();
            await recordMutation({ type: "create", path: "new.md" });
            await recordMutation({ type: "update", path: "existing.md" });

            const session = await getSession(id);
            expect(session?.mutations).toHaveLength(2);
            expect(session?.mutations[0].type).toBe("create");
            expect(session?.mutations[0].path).toBe("new.md");
            expect(session?.mutations[1].type).toBe("update");
        });

        it("adds timestamp and sessionId to each mutation", async () => {
            const id = await startSession();
            await recordMutation({ type: "delete", path: "gone.md" });

            const session = await getSession(id);
            const mutation = session?.mutations[0];
            expect(mutation?.timestamp).toBeDefined();
            expect(mutation?.sessionId).toBe(id);
        });
    });

    describe("endSession", () => {
        it("returns undefined when no session is active", async () => {
            expect(getCurrentSessionId()).toBeUndefined();
            const result = await endSession();
            expect(result).toBeUndefined();
        });

        it("computes summary counts from mutations", async () => {
            await startSession();
            await recordMutation({ type: "create", path: "a.md" });
            await recordMutation({ type: "create", path: "b.md" });
            await recordMutation({ type: "update", path: "a.md" });
            await recordMutation({ type: "delete", path: "old.md" });
            await recordMutation({ type: "move", path: "moved.md", oldPath: "original.md" });

            const ended = await endSession();
            expect(ended?.summary).toEqual({
                created: 2,
                updated: 1,
                deleted: 1,
                moved: 1,
                restored: 0,
            });
        });

        it("clears the current session ID", async () => {
            await startSession();
            await endSession();
            expect(getCurrentSessionId()).toBeUndefined();
        });

        it("sets endedAt timestamp", async () => {
            await startSession();
            const ended = await endSession();
            expect(ended?.endedAt).toBeDefined();
            expect(ended?.endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        });
    });

    describe("getSessions", () => {
        it("returns sessions in reverse chronological order", async () => {
            const first = await startSession();
            await recordMutation({ type: "create", path: "first.md" });
            await endSession();

            const second = await startSession();
            await recordMutation({ type: "create", path: "second.md" });
            await endSession();

            const sessions = await getSessions();
            expect(sessions.length).toBeGreaterThanOrEqual(2);
            expect(sessions[0].sessionId).toBe(second);
            expect(sessions[1].sessionId).toBe(first);
        });

        it("respects the limit parameter", async () => {
            for (let i = 0; i < 5; i++) {
                await startSession();
                await endSession();
            }
            const sessions = await getSessions(3);
            expect(sessions.length).toBeLessThanOrEqual(3);
        });
    });

    describe("getSession", () => {
        it("returns undefined for unknown session ID", async () => {
            const session = await getSession("nonexistent");
            expect(session).toBeUndefined();
        });

        it("retrieves a specific session by ID", async () => {
            const id = await startSession();
            await recordMutation({ type: "create", path: "specific.md" });
            await endSession();

            const session = await getSession(id);
            expect(session).toBeDefined();
            expect(session?.sessionId).toBe(id);
            expect(session?.mutations).toHaveLength(1);
        });
    });
});
