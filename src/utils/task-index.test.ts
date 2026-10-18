/**
 * Tests for the task index utility: parsing, filtering, and metadata extraction.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
    parseTasksFromFile,
    parseTaskLine,
    extractDueDate,
    extractTags,
    extractPriority,
    extractDescription,
    buildTaskLine,
    taskIndex,
} from "../utils/task-index.js";
import { initVault } from "../utils/vault.js";

let testCounter = 0;
let TEST_VAULT = "";

describe("task-index", () => {
    beforeEach(async () => {
        TEST_VAULT = join(process.cwd(), `test-vault-task-index-${process.pid}-${testCounter++}`);
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

    // ─── Parsing Tests ────────────────────────────────────────────────

    describe("parseTaskLine", () => {
        it("parses a pending task", () => {
            const task = parseTaskLine("- [ ] Buy groceries", "notes.md", 1);
            expect(task).not.toBeNull();
            expect(task!.status).toBe("pending");
            expect(task!.description).toBe("Buy groceries");
            expect(task!.filePath).toBe("notes.md");
            expect(task!.lineNum).toBe(1);
        });

        it("parses a completed task", () => {
            const task = parseTaskLine("- [x] Buy groceries", "notes.md", 5);
            expect(task).not.toBeNull();
            expect(task!.status).toBe("complete");
            expect(task!.description).toBe("Buy groceries");
        });

        it("parses a task with uppercase X", () => {
            const task = parseTaskLine("- [X] Done task", "notes.md", 1);
            expect(task).not.toBeNull();
            expect(task!.status).toBe("complete");
        });

        it("parses an indented task", () => {
            const task = parseTaskLine("  - [ ] Sub-task", "notes.md", 3);
            expect(task).not.toBeNull();
            expect(task!.description).toBe("Sub-task");
        });

        it("returns null for non-task lines", () => {
            expect(parseTaskLine("# Heading", "notes.md", 1)).toBeNull();
            expect(parseTaskLine("Regular text", "notes.md", 1)).toBeNull();
            expect(parseTaskLine("- Not a task", "notes.md", 1)).toBeNull();
            expect(parseTaskLine("", "notes.md", 1)).toBeNull();
        });
    });

    describe("metadata extraction", () => {
        it("extracts due date", () => {
            expect(extractDueDate("Task \u{1F4C5} 2026-10-20")).toBe("2026-10-20");
            expect(extractDueDate("Task without date")).toBeNull();
        });

        it("extracts tags", () => {
            const tags = extractTags("Task \u{1F3F7}\u{FE0F} work,urgent");
            expect(tags).toEqual(["work", "urgent"]);
        });

        it("extracts tags with spaces", () => {
            const tags = extractTags("Task \u{1F3F7}\u{FE0F} work, urgent, home");
            expect(tags).toEqual(["work", "urgent", "home"]);
        });

        it("returns empty tags when none present", () => {
            expect(extractTags("Simple task")).toEqual([]);
        });

        it("extracts priority", () => {
            expect(extractPriority("Task \u{1F4CC} high")).toBe("high");
            expect(extractPriority("Task \u{1F4CC} medium")).toBe("medium");
            expect(extractPriority("Task \u{1F4CC} low")).toBe("low");
            expect(extractPriority("Task without priority")).toBeNull();
        });

        it("extracts clean description (strips metadata)", () => {
            const desc = extractDescription("Buy groceries \u{1F4C5} 2026-10-20 \u{1F3F7}\u{FE0F} shopping \u{1F4CC} high");
            expect(desc).toBe("Buy groceries");
        });

        it("extracts description with no metadata", () => {
            expect(extractDescription("Simple task")).toBe("Simple task");
        });
    });

    describe("parseTasksFromFile", () => {
        it("parses multiple tasks from content", () => {
            const content = [
                "# My Tasks",
                "",
                "- [ ] Task one",
                "- [x] Task two",
                "- [ ] Task three \u{1F4C5} 2026-10-20",
                "Some text",
                "- [ ] Task four \u{1F3F7}\u{FE0F} work \u{1F4CC} high",
            ].join("\n");

            const tasks = parseTasksFromFile(content, "tasks.md");
            expect(tasks).toHaveLength(4);
            expect(tasks[0].status).toBe("pending");
            expect(tasks[0].description).toBe("Task one");
            expect(tasks[1].status).toBe("complete");
            expect(tasks[2].dueDate).toBe("2026-10-20");
            expect(tasks[3].tags).toEqual(["work"]);
            expect(tasks[3].priority).toBe("high");
        });

        it("returns empty array for content with no tasks", () => {
            const tasks = parseTasksFromFile("# Just a heading\n\nSome text.", "notes.md");
            expect(tasks).toHaveLength(0);
        });
    });

    describe("buildTaskLine", () => {
        it("builds a basic pending task line", () => {
            expect(buildTaskLine("Buy groceries")).toBe("- [ ] Buy groceries");
        });

        it("builds a complete task line", () => {
            expect(buildTaskLine("Buy groceries", "complete")).toBe("- [x] Buy groceries");
        });

        it("builds a task with all metadata", () => {
            const line = buildTaskLine("Buy groceries", "pending", "2026-10-20", ["shopping", "urgent"], "high");
            expect(line).toContain("- [ ] Buy groceries");
            expect(line).toContain("\u{1F4C5} 2026-10-20");
            expect(line).toContain("\u{1F3F7}\u{FE0F} shopping,urgent");
            expect(line).toContain("\u{1F4CC} high");
        });

        it("builds a task with only some metadata", () => {
            const line = buildTaskLine("Task", "pending", "2026-10-20");
            expect(line).toContain("\u{1F4C5} 2026-10-20");
            expect(line).not.toContain("\u{1F3F7}");
            expect(line).not.toContain("\u{1F4CC}");
        });
    });

    // ─── Task Index Integration Tests ─────────────────────────────────

    describe("taskIndex", () => {
        it("scans vault for tasks", async () => {
            await writeFile(
                join(TEST_VAULT, "tasks.md"),
                "# Tasks\n\n- [ ] Task A\n- [x] Task B\n",
            );
            await writeFile(
                join(TEST_VAULT, "projects", "project1.md"),
                "# Project\n\n- [ ] Project task \u{1F4CC} high\n",
            );

            const tasks = await taskIndex.getAllTasks();
            expect(tasks.length).toBeGreaterThanOrEqual(3);

            const taskA = tasks.find((t) => t.description === "Task A");
            expect(taskA).toBeDefined();
            expect(taskA!.status).toBe("pending");

            const projectTask = tasks.find((t) => t.description === "Project task");
            expect(projectTask).toBeDefined();
            expect(projectTask!.priority).toBe("high");
        });

        it("filters by status", async () => {
            await writeFile(
                join(TEST_VAULT, "tasks.md"),
                "- [ ] Pending\n- [x] Complete\n",
            );

            const pending = await taskIndex.getTasks({ status: "pending" });
            expect(pending.every((t) => t.status === "pending")).toBe(true);

            taskIndex.markDirty();
            const complete = await taskIndex.getTasks({ status: "complete" });
            expect(complete.every((t) => t.status === "complete")).toBe(true);
        });

        it("filters by project (folder)", async () => {
            await writeFile(join(TEST_VAULT, "tasks.md"), "- [ ] Root task\n");
            await writeFile(join(TEST_VAULT, "projects", "proj.md"), "- [ ] Project task\n");

            taskIndex.markDirty();
            const projectTasks = await taskIndex.getTasks({ project: "projects" });
            expect(projectTasks.every((t) => t.filePath.startsWith("projects/"))).toBe(true);
        });

        it("filters by tags", async () => {
            await writeFile(
                join(TEST_VAULT, "tasks.md"),
                "- [ ] Task A \u{1F3F7}\u{FE0F} work,urgent\n- [ ] Task B \u{1F3F7}\u{FE0F} home\n",
            );

            taskIndex.markDirty();
            const workTasks = await taskIndex.getTasks({ tags: ["work"] });
            expect(workTasks.length).toBe(1);
            expect(workTasks[0].description).toBe("Task A");
        });

        it("filters by priority", async () => {
            await writeFile(
                join(TEST_VAULT, "tasks.md"),
                "- [ ] High \u{1F4CC} high\n- [ ] Low \u{1F4CC} low\n- [ ] None\n",
            );

            taskIndex.markDirty();
            const highTasks = await taskIndex.getTasks({ priority: "high" });
            expect(highTasks.length).toBe(1);
            expect(highTasks[0].description).toBe("High");
        });

        it("filters by due date range", async () => {
            await writeFile(
                join(TEST_VAULT, "tasks.md"),
                "- [ ] Early \u{1F4C5} 2026-01-01\n- [ ] Mid \u{1F4C5} 2026-06-15\n- [ ] Late \u{1F4C5} 2026-12-31\n",
            );

            taskIndex.markDirty();
            const midYear = await taskIndex.getTasks({ dueAfter: "2026-03-01", dueBefore: "2026-09-01" });
            expect(midYear.length).toBe(1);
            expect(midYear[0].description).toBe("Mid");
        });

        it("filters by query text", async () => {
            await writeFile(
                join(TEST_VAULT, "tasks.md"),
                "- [ ] Buy groceries\n- [ ] Clean house\n- [ ] Buy books\n",
            );

            taskIndex.markDirty();
            const buyTasks = await taskIndex.getTasks({ query: "buy" });
            expect(buyTasks.length).toBe(2);
        });

        it("filters tasks with/without due dates", async () => {
            await writeFile(
                join(TEST_VAULT, "tasks.md"),
                "- [ ] With date \u{1F4C5} 2026-10-20\n- [ ] Without date\n",
            );

            taskIndex.markDirty();
            const withDue = await taskIndex.getTasks({ hasDueDate: true });
            expect(withDue.length).toBe(1);
            expect(withDue[0].description).toBe("With date");

            taskIndex.markDirty();
            const withoutDue = await taskIndex.getTasks({ hasDueDate: false });
            expect(withoutDue.length).toBe(1);
            expect(withoutDue[0].description).toBe("Without date");
        });

        it("excludes .trash directory", async () => {
            await mkdir(join(TEST_VAULT, ".trash"), { recursive: true });
            await writeFile(join(TEST_VAULT, ".trash", "deleted.md"), "- [ ] Deleted task\n");
            await writeFile(join(TEST_VAULT, "active.md"), "- [ ] Active task\n");

            taskIndex.markDirty();
            const tasks = await taskIndex.getAllTasks();
            expect(tasks.every((t) => !t.filePath.includes(".trash"))).toBe(true);
        });

        it("returns stats", async () => {
            await writeFile(
                join(TEST_VAULT, "tasks.md"),
                "- [ ] One\n- [x] Two\n- [ ] Three\n",
            );

            taskIndex.markDirty();
            const stats = await taskIndex.getStats();
            expect(stats.totalTasks).toBe(3);
            expect(stats.pending).toBe(2);
            expect(stats.complete).toBe(1);
            expect(stats.filesScanned).toBeGreaterThanOrEqual(1);
        });
    });
});
