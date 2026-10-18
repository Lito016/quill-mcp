/**
 * Tests for the list-tasks tool handler.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initVault } from "../utils/vault.js";
import { handler } from "./list-tasks.js";
import { taskIndex } from "../utils/task-index.js";

let testCounter = 0;
let TEST_VAULT = "";

describe("list-tasks tool", () => {
    beforeEach(async () => {
        TEST_VAULT = join(process.cwd(), `test-vault-list-tasks-${process.pid}-${testCounter++}`);
        await rm(TEST_VAULT, { recursive: true, force: true });
        await mkdir(TEST_VAULT, { recursive: true });
        await mkdir(join(TEST_VAULT, "projects"), { recursive: true });
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

    it("lists all tasks in the vault", async () => {
        await writeFile(join(TEST_VAULT, "tasks.md"), "- [ ] Task A\n- [x] Task B\n");

        const result = await handler({
            sort: "file",
            offset: 0,
        });

        expect(result.content[0].text).toContain("2 task(s)");
        expect(result.content[0].text).toContain("Task A");
        expect(result.content[0].text).toContain("Task B");
    });

    it("filters by status", async () => {
        await writeFile(join(TEST_VAULT, "tasks.md"), "- [ ] Pending\n- [x] Complete\n");

        const result = await handler({
            status: "pending",
            sort: "file",
            offset: 0,
        });

        expect(result.content[0].text).toContain("1 task(s)");
        expect(result.content[0].text).toContain("Pending");
        expect(result.content[0].text).not.toContain("Complete");
    });

    it("filters by project", async () => {
        await writeFile(join(TEST_VAULT, "tasks.md"), "- [ ] Root task\n");
        await writeFile(join(TEST_VAULT, "projects", "proj.md"), "- [ ] Project task\n");

        taskIndex.markDirty();
        const result = await handler({
            project: "projects",
            sort: "file",
            offset: 0,
        });

        expect(result.content[0].text).toContain("1 task(s)");
        expect(result.content[0].text).toContain("Project task");
    });

    it("filters by tags", async () => {
        await writeFile(
            join(TEST_VAULT, "tasks.md"),
            "- [ ] Work task \u{1F3F7}\u{FE0F} work\n- [ ] Home task \u{1F3F7}\u{FE0F} home\n",
        );

        taskIndex.markDirty();
        const result = await handler({
            tags: ["work"],
            sort: "file",
            offset: 0,
        });

        expect(result.content[0].text).toContain("1 task(s)");
        expect(result.content[0].text).toContain("Work task");
    });

    it("filters by priority", async () => {
        await writeFile(
            join(TEST_VAULT, "tasks.md"),
            "- [ ] High \u{1F4CC} high\n- [ ] Low \u{1F4CC} low\n",
        );

        taskIndex.markDirty();
        const result = await handler({
            priority: "high",
            sort: "file",
            offset: 0,
        });

        expect(result.content[0].text).toContain("1 task(s)");
        expect(result.content[0].text).toContain("High");
    });

    it("sorts by due date", async () => {
        await writeFile(
            join(TEST_VAULT, "tasks.md"),
            "- [ ] Late \u{1F4C5} 2026-12-31\n- [ ] Early \u{1F4C5} 2026-01-01\n",
        );

        taskIndex.markDirty();
        const result = await handler({
            sort: "due_date",
            offset: 0,
        });

        const text = result.content[0].text;
        const earlyPos = text.indexOf("Early");
        const latePos = text.indexOf("Late");
        expect(earlyPos).toBeLessThan(latePos);
    });

    it("sorts by priority", async () => {
        await writeFile(
            join(TEST_VAULT, "tasks.md"),
            "- [ ] Low \u{1F4CC} low\n- [ ] High \u{1F4CC} high\n- [ ] Med \u{1F4CC} medium\n",
        );

        taskIndex.markDirty();
        const result = await handler({
            sort: "priority",
            offset: 0,
        });

        const text = result.content[0].text;
        const highPos = text.indexOf("High");
        const medPos = text.indexOf("Med");
        const lowPos = text.indexOf("Low");
        expect(highPos).toBeLessThan(medPos);
        expect(medPos).toBeLessThan(lowPos);
    });

    it("supports pagination", async () => {
        await writeFile(
            join(TEST_VAULT, "tasks.md"),
            "- [ ] Task 1\n- [ ] Task 2\n- [ ] Task 3\n- [ ] Task 4\n- [ ] Task 5\n",
        );

        taskIndex.markDirty();
        const result = await handler({
            sort: "file",
            limit: 2,
            offset: 0,
        });

        expect(result.content[0].text).toContain("Showing 2 of 5");
    });

    it("returns message when no tasks found", async () => {
        await writeFile(join(TEST_VAULT, "tasks.md"), "# No tasks here\n");

        taskIndex.markDirty();
        const result = await handler({
            sort: "file",
            offset: 0,
        });

        expect(result.content[0].text).toContain("No tasks found");
    });

    it("filters by due date range", async () => {
        await writeFile(
            join(TEST_VAULT, "tasks.md"),
            "- [ ] Jan \u{1F4C5} 2026-01-15\n- [ ] Jun \u{1F4C5} 2026-06-15\n- [ ] Dec \u{1F4C5} 2026-12-15\n",
        );

        taskIndex.markDirty();
        const result = await handler({
            due_after: "2026-03-01",
            due_before: "2026-09-01",
            sort: "file",
            offset: 0,
        });

        expect(result.content[0].text).toContain("1 task(s)");
        expect(result.content[0].text).toContain("Jun");
    });
});
