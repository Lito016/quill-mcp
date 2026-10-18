/**
 * Tests for the create-task tool handler.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { initVault } from "../utils/vault.js";
import { handler } from "./create-task.js";
import { taskIndex } from "../utils/task-index.js";

let testCounter = 0;
let TEST_VAULT = "";

describe("create-task tool", () => {
    beforeEach(async () => {
        TEST_VAULT = join(process.cwd(), `test-vault-create-task-${process.pid}-${testCounter++}`);
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

    it("creates a task in a new file (default tasks.md)", async () => {
        const result = await handler({
            description: "Buy groceries",
            note: "tasks.md",
        });
        expect(result.content[0].text).toContain("Task created");
        expect(result.content[0].text).toContain("new note");

        const content = await readFile(join(TEST_VAULT, "tasks.md"), "utf-8");
        expect(content).toContain("- [ ] Buy groceries");
    });

    it("creates a task with due date", async () => {
        await handler({
            description: "Submit report",
            note: "tasks.md",
            due_date: "2026-10-20",
        });

        const content = await readFile(join(TEST_VAULT, "tasks.md"), "utf-8");
        expect(content).toContain("\u{1F4C5} 2026-10-20");
    });

    it("creates a task with tags and priority", async () => {
        await handler({
            description: "Fix bug",
            note: "tasks.md",
            tags: ["work", "urgent"],
            priority: "high",
        });

        const content = await readFile(join(TEST_VAULT, "tasks.md"), "utf-8");
        expect(content).toContain("\u{1F3F7}\u{FE0F} work,urgent");
        expect(content).toContain("\u{1F4CC} high");
    });

    it("appends to an existing note", async () => {
        // Create the file first
        const { writeFile } = await import("node:fs/promises");
        await writeFile(join(TEST_VAULT, "my-tasks.md"), "# My Tasks\n\n- [ ] Existing task\n");

        await handler({
            description: "New task",
            note: "my-tasks.md",
        });

        const content = await readFile(join(TEST_VAULT, "my-tasks.md"), "utf-8");
        expect(content).toContain("- [ ] Existing task");
        expect(content).toContain("- [ ] New task");
    });

    it("creates a task in a specific section", async () => {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(
            join(TEST_VAULT, "tasks.md"),
            "# Tasks\n\n## In Progress\n\n- [ ] Existing\n\n## Done\n\n- [x] Completed\n",
        );

        await handler({
            description: "New in-progress task",
            note: "tasks.md",
            section: "In Progress",
        });

        const content = await readFile(join(TEST_VAULT, "tasks.md"), "utf-8");
        const inProgressPos = content.indexOf("## In Progress");
        const donePos = content.indexOf("## Done");
        const newTaskPos = content.indexOf("New in-progress task");
        expect(newTaskPos).toBeGreaterThan(inProgressPos);
        expect(newTaskPos).toBeLessThan(donePos);
    });

    it("creates section if it doesn't exist", async () => {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(join(TEST_VAULT, "tasks.md"), "# Tasks\n\n- [ ] Existing\n");

        await handler({
            description: "New task",
            note: "tasks.md",
            section: "Backlog",
        });

        const content = await readFile(join(TEST_VAULT, "tasks.md"), "utf-8");
        expect(content).toContain("## Backlog");
        expect(content).toContain("- [ ] New task");
    });

    it("auto-appends .md extension", async () => {
        await handler({
            description: "Test task",
            note: "my-tasks",
        });

        const content = await readFile(join(TEST_VAULT, "my-tasks.md"), "utf-8");
        expect(content).toContain("- [ ] Test task");
    });

    it("creates task in a subdirectory", async () => {
        await handler({
            description: "Project task",
            note: "projects/my-project/tasks.md",
        });

        const content = await readFile(join(TEST_VAULT, "projects", "my-project", "tasks.md"), "utf-8");
        expect(content).toContain("- [ ] Project task");
    });
});
