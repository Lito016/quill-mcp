/**
 * Tests for the list-recurring tool handler.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initVault } from "../utils/vault.js";
import { handler } from "./list-recurring.js";
import { taskIndex } from "../utils/task-index.js";
import { saveRecurrenceState, type RecurrenceStateFile } from "../utils/recurring-engine.js";

let testCounter = 0;
let TEST_VAULT = "";

describe("list-recurring tool", () => {
    beforeEach(async () => {
        TEST_VAULT = join(process.cwd(), `test-vault-list-recurring-${process.pid}-${testCounter++}`);
        await rm(TEST_VAULT, { recursive: true, force: true });
        await mkdir(TEST_VAULT, { recursive: true });
        process.env.NOTES_VAULT_PATH = TEST_VAULT;
        initVault();
        taskIndex.markDirty();
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

    it("lists recurring tasks", async () => {
        await writeFile(
            join(TEST_VAULT, "tasks.md"),
            "- [ ] Daily task \u{1F504} daily\n- [ ] Weekly task \u{1F504} weekly\n- [ ] Regular task\n",
        );

        const result = await handler({
            status_filter: "all",
            sort: "file",
            offset: 0,
        });

        expect(result.content[0].text).toContain("2 recurring task");
        expect(result.content[0].text).toContain("Daily task");
        expect(result.content[0].text).toContain("Weekly task");
        expect(result.content[0].text).not.toContain("Regular task");
    });

    it("returns message when no recurring tasks", async () => {
        await writeFile(join(TEST_VAULT, "tasks.md"), "- [ ] Regular task\n");

        const result = await handler({
            status_filter: "all",
            sort: "file",
            offset: 0,
        });

        expect(result.content[0].text).toContain("No recurring tasks");
    });

    it("filters by pattern type", async () => {
        await writeFile(
            join(TEST_VAULT, "tasks.md"),
            "- [ ] Daily \u{1F504} daily\n- [ ] Weekly \u{1F504} weekly\n",
        );

        const result = await handler({
            pattern_type: "daily",
            status_filter: "all",
            sort: "file",
            offset: 0,
        });

        expect(result.content[0].text).toContain("1 recurring task");
        expect(result.content[0].text).toContain("Daily");
    });

    it("filters paused tasks", async () => {
        await writeFile(join(TEST_VAULT, "tasks.md"), "- [ ] Task \u{1F504} daily\n");

        // Save state with paused entry
        const state: RecurrenceStateFile = {
            version: 1,
            entries: [
                {
                    taskId: "tasks.md:1",
                    lastCompleted: null,
                    nextDue: "2099-12-31",
                    paused: true,
                    skipCount: 0,
                    pattern: "daily",
                    description: "Task",
                    filePath: "tasks.md",
                    lineNum: 1,
                },
            ],
        };
        await saveRecurrenceState(state);

        const result = await handler({
            status_filter: "paused",
            sort: "file",
            offset: 0,
        });

        expect(result.content[0].text).toContain("PAUSED");
    });

    it("supports pagination", async () => {
        await writeFile(
            join(TEST_VAULT, "tasks.md"),
            "- [ ] Task1 \u{1F504} daily\n- [ ] Task2 \u{1F504} daily\n- [ ] Task3 \u{1F504} daily\n",
        );

        const result = await handler({
            status_filter: "all",
            sort: "file",
            limit: 2,
            offset: 0,
        });

        expect(result.content[0].text).toContain("Showing 2 of 3");
    });
});
