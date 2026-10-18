/**
 * Tests for skip-recurrence, pause-recurrence, and resume-recurrence tools.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { initVault } from "../utils/vault.js";
import { handler as skipHandler } from "./skip-recurrence.js";
import { handler as pauseHandler } from "./pause-recurrence.js";
import { handler as resumeHandler } from "./resume-recurrence.js";
import {
    saveRecurrenceState,
    loadRecurrenceState,
    type RecurrenceStateFile,
    type RecurrenceState,
} from "../utils/recurring-engine.js";

let testCounter = 0;
let TEST_VAULT = "";

function makeState(overrides: Partial<RecurrenceState> = {}): RecurrenceStateFile {
    return {
        version: 1,
        entries: [
            {
                taskId: "tasks.md:1",
                lastCompleted: "2026-10-17T00:00:00.000Z",
                nextDue: "2026-10-18",
                paused: false,
                skipCount: 0,
                pattern: "daily",
                description: "Daily task",
                filePath: "tasks.md",
                lineNum: 1,
                ...overrides,
            },
        ],
    };
}

describe("skip-recurrence tool", () => {
    beforeEach(async () => {
        TEST_VAULT = join(process.cwd(), `test-vault-skip-recurring-${process.pid}-${testCounter++}`);
        await rm(TEST_VAULT, { recursive: true, force: true });
        await mkdir(TEST_VAULT, { recursive: true });
        process.env.NOTES_VAULT_PATH = TEST_VAULT;
        initVault();
    });

    afterEach(async () => {
        delete process.env.NOTES_VAULT_PATH;
        try {
            await Promise.race([
                rm(TEST_VAULT, { recursive: true, force: true }),
                new Promise((_, reject) => setTimeout(() => reject(new Error("cleanup timeout")), 5000)),
            ]);
        } catch {
            // Best effort
        }
    }, 10000);

    it("skips one occurrence by task_id", async () => {
        await saveRecurrenceState(makeState());

        const result = await skipHandler({
            task_id: "tasks.md:1",
            count: 1,
        });

        expect(result.content[0].text).toContain("Skipped 1 occurrence");
        expect(result.content[0].text).toContain("Next due: 2026-10-19");

        const state = await loadRecurrenceState();
        expect(state.entries[0].nextDue).toBe("2026-10-19");
        expect(state.entries[0].skipCount).toBe(1);
    });

    it("skips multiple occurrences", async () => {
        await saveRecurrenceState(makeState());

        const result = await skipHandler({
            task_id: "tasks.md:1",
            count: 3,
        });

        expect(result.content[0].text).toContain("Skipped 3 occurrences");

        const state = await loadRecurrenceState();
        expect(state.entries[0].skipCount).toBe(3);
        // daily: 18 -> 19 -> 20 -> 21
        expect(state.entries[0].nextDue).toBe("2026-10-21");
    });

    it("skips by search text", async () => {
        await saveRecurrenceState(makeState());

        const result = await skipHandler({
            search: "Daily",
            count: 1,
        });

        expect(result.content[0].text).toContain("Skipped");
    });

    it("returns error when task not found", async () => {
        await saveRecurrenceState({ version: 1, entries: [] });

        const result = await skipHandler({
            task_id: "nonexistent:1",
            count: 1,
        }) as { content: { type: "text"; text: string }[]; isError?: boolean };

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("not found");
    });

    it("returns error when task is paused", async () => {
        await saveRecurrenceState(makeState({ paused: true }));

        const result = await skipHandler({
            task_id: "tasks.md:1",
            count: 1,
        }) as { content: { type: "text"; text: string }[]; isError?: boolean };

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("paused");
    });

    it("skips by note and line", async () => {
        await saveRecurrenceState(makeState());

        const result = await skipHandler({
            note: "tasks.md",
            line: 1,
            count: 1,
        });

        expect(result.content[0].text).toContain("Skipped");
    });
});

describe("pause-recurrence tool", () => {
    beforeEach(async () => {
        TEST_VAULT = join(process.cwd(), `test-vault-pause-recurring-${process.pid}-${testCounter++}`);
        await rm(TEST_VAULT, { recursive: true, force: true });
        await mkdir(TEST_VAULT, { recursive: true });
        process.env.NOTES_VAULT_PATH = TEST_VAULT;
        initVault();
    });

    afterEach(async () => {
        delete process.env.NOTES_VAULT_PATH;
        try {
            await Promise.race([
                rm(TEST_VAULT, { recursive: true, force: true }),
                new Promise((_, reject) => setTimeout(() => reject(new Error("cleanup timeout")), 5000)),
            ]);
        } catch {
            // Best effort
        }
    }, 10000);

    it("pauses a recurring task", async () => {
        await saveRecurrenceState(makeState());

        const result = await pauseHandler({
            task_id: "tasks.md:1",
        });

        expect(result.content[0].text).toContain("paused");

        const state = await loadRecurrenceState();
        expect(state.entries[0].paused).toBe(true);
    });

    it("reports already paused", async () => {
        await saveRecurrenceState(makeState({ paused: true }));

        const result = await pauseHandler({
            task_id: "tasks.md:1",
        });

        expect(result.content[0].text).toContain("already paused");
    });

    it("pauses by search", async () => {
        await saveRecurrenceState(makeState());

        const result = await pauseHandler({
            search: "Daily",
        });

        expect(result.content[0].text).toContain("paused");
    });

    it("returns error when task not found", async () => {
        await saveRecurrenceState({ version: 1, entries: [] });

        const result = await pauseHandler({
            task_id: "nonexistent:1",
        }) as { content: { type: "text"; text: string }[]; isError?: boolean };

        expect(result.isError).toBe(true);
    });

    it("pauses by note and line", async () => {
        await saveRecurrenceState(makeState());

        const result = await pauseHandler({
            note: "tasks.md",
            line: 1,
        });

        expect(result.content[0].text).toContain("paused");
    });
});

describe("resume-recurrence tool", () => {
    beforeEach(async () => {
        TEST_VAULT = join(process.cwd(), `test-vault-resume-recurring-${process.pid}-${testCounter++}`);
        await rm(TEST_VAULT, { recursive: true, force: true });
        await mkdir(TEST_VAULT, { recursive: true });
        process.env.NOTES_VAULT_PATH = TEST_VAULT;
        initVault();
    });

    afterEach(async () => {
        delete process.env.NOTES_VAULT_PATH;
        try {
            await Promise.race([
                rm(TEST_VAULT, { recursive: true, force: true }),
                new Promise((_, reject) => setTimeout(() => reject(new Error("cleanup timeout")), 5000)),
            ]);
        } catch {
            // Best effort
        }
    }, 10000);

    it("resumes a paused task", async () => {
        await saveRecurrenceState(makeState({ paused: true, nextDue: "2099-12-31" }));

        const result = await resumeHandler({
            task_id: "tasks.md:1",
        });

        expect(result.content[0].text).toContain("resumed");

        const state = await loadRecurrenceState();
        expect(state.entries[0].paused).toBe(false);
        // Next due should be preserved since it's in the future
        expect(state.entries[0].nextDue).toBe("2099-12-31");
    });

    it("recomputes next due when past", async () => {
        await saveRecurrenceState(makeState({ paused: true, nextDue: "2020-01-01" }));

        const result = await resumeHandler({
            task_id: "tasks.md:1",
        });

        expect(result.content[0].text).toContain("resumed");

        const state = await loadRecurrenceState();
        expect(state.entries[0].paused).toBe(false);
        // Next due should be recomputed from today (in the future)
        expect(state.entries[0].nextDue > "2026-01-01").toBe(true);
    });

    it("reports not paused", async () => {
        await saveRecurrenceState(makeState({ paused: false }));

        const result = await resumeHandler({
            task_id: "tasks.md:1",
        });

        expect(result.content[0].text).toContain("not paused");
    });

    it("resumes by search", async () => {
        await saveRecurrenceState(makeState({ paused: true, nextDue: "2099-12-31" }));

        const result = await resumeHandler({
            search: "Daily",
        });

        expect(result.content[0].text).toContain("resumed");
    });

    it("returns error when task not found", async () => {
        await saveRecurrenceState({ version: 1, entries: [] });

        const result = await resumeHandler({
            task_id: "nonexistent:1",
        }) as { content: { type: "text"; text: string }[]; isError?: boolean };

        expect(result.isError).toBe(true);
    });
});
