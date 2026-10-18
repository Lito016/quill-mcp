/**
 * Tests for Kanban board tools: create-board, list-boards, read-board,
 * move-task, add-to-column, archive-column, rename-column, reorder-columns.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initVault } from "../utils/vault.js";
import { kanbanIndex } from "../utils/kanban-index.js";
import { handler as createBoard } from "./create-board.js";
import { handler as listBoards } from "./list-boards.js";
import { handler as readBoard } from "./read-board.js";
import { handler as moveTask } from "./move-task.js";
import { handler as addToColumn } from "./add-to-column.js";
import { handler as archiveColumn } from "./archive-column.js";
import { handler as renameColumn } from "./rename-column.js";
import { handler as reorderColumns } from "./reorder-columns.js";

let testCounter = 0;
let TEST_VAULT = "";

describe("Kanban board tools", () => {
    beforeEach(async () => {
        TEST_VAULT = join(process.cwd(), `test-vault-kanban-tools-${process.pid}-${testCounter++}`);
        await rm(TEST_VAULT, { recursive: true, force: true });
        await mkdir(TEST_VAULT, { recursive: true });
        process.env.NOTES_VAULT_PATH = TEST_VAULT;
        initVault();
        kanbanIndex.markDirty();
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

    // ─── create-board ────────────────────────────────────────────────

    describe("create-board", () => {
        it("creates a board with default columns", async () => {
            const result = await createBoard({ board_name: "My Project", columns: ["Todo", "In Progress", "Done"] });
            expect(result.content[0].text).toContain("My Project");
            expect(result.content[0].text).toContain("boards/my-project.md");

            const content = await readFile(join(TEST_VAULT, "boards", "my-project.md"), "utf-8");
            expect(content).toContain("type: kanban");
            expect(content).toContain("# My Project");
            expect(content).toContain("## Todo");
            expect(content).toContain("## In Progress");
            expect(content).toContain("## Done");
        });

        it("creates a board with custom path", async () => {
            const result = await createBoard({
                board_name: "Sprint Board",
                path: "projects/sprint.md",
                columns: ["Backlog", "Active", "Review"],
            });
            expect(result.content[0].text).toContain("projects/sprint.md");

            const content = await readFile(join(TEST_VAULT, "projects", "sprint.md"), "utf-8");
            expect(content).toContain("## Backlog");
            expect(content).toContain("## Active");
            expect(content).toContain("## Review");
        });

        it("creates a board with description", async () => {
            await createBoard({
                board_name: "Described Board",
                columns: ["Todo", "Done"],
                description: "This is a test board.",
            });

            const content = await readFile(join(TEST_VAULT, "boards", "described-board.md"), "utf-8");
            expect(content).toContain("This is a test board.");
        });

        it("fails if board already exists", async () => {
            await createBoard({ board_name: "Duplicate", columns: ["Todo", "Done"] });
            const result = await createBoard({ board_name: "Duplicate", columns: ["Todo", "Done"] });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain("already exists");
        });

        it("fails with empty columns", async () => {
            const result = await createBoard({ board_name: "Empty", columns: [] });
            expect(result.isError).toBe(true);
        });
    });

    // ─── list-boards ─────────────────────────────────────────────────

    describe("list-boards", () => {
        it("lists all boards", async () => {
            await createBoard({ board_name: "Board A", columns: ["Todo", "Done"] });
            await createBoard({ board_name: "Board B", path: "other.md", columns: ["X", "Y"] });
            kanbanIndex.markDirty();

            const result = await listBoards({ include_stats: true });
            expect(result.content[0].text).toContain("Board A");
            expect(result.content[0].text).toContain("Board B");
            expect(result.content[0].text).toContain("2 Kanban board(s)");
        });

        it("shows empty message when no boards", async () => {
            const result = await listBoards({ include_stats: true });
            expect(result.content[0].text).toContain("No Kanban boards found");
        });
    });

    // ─── read-board ──────────────────────────────────────────────────

    describe("read-board", () => {
        it("reads a board with tasks", async () => {
            await createBoard({ board_name: "Read Test", columns: ["Todo", "Done"] });
            await addToColumn({
                path: "boards/read-test.md",
                column: "Todo",
                description: "Task 1",
                completed: false,
            });
            await addToColumn({
                path: "boards/read-test.md",
                column: "Done",
                description: "Task 2",
                completed: true,
            });

            const result = await readBoard({ path: "boards/read-test.md", compact: false });
            expect(result.content[0].text).toContain("Read Test");
            expect(result.content[0].text).toContain("Task 1");
            expect(result.content[0].text).toContain("Task 2");
        });

        it("shows compact view", async () => {
            await createBoard({ board_name: "Compact", columns: ["A", "B"] });
            await addToColumn({ path: "boards/compact.md", column: "A", description: "T1", completed: false });

            const result = await readBoard({ path: "boards/compact.md", compact: true });
            expect(result.content[0].text).toContain("1 tasks");
        });

        it("errors on missing board", async () => {
            const result = await readBoard({ path: "nonexistent.md", compact: false });
            expect(result.isError).toBe(true);
        });
    });

    // ─── move-task ───────────────────────────────────────────────────

    describe("move-task", () => {
        it("moves a task between columns", async () => {
            await createBoard({ board_name: "Move Test", columns: ["Todo", "Done"] });
            await addToColumn({
                path: "boards/move-test.md",
                column: "Todo",
                description: "Move me",
                completed: false,
            });

            const result = await moveTask({
                path: "boards/move-test.md",
                task: "Move me",
                to_column: "Done",
            });
            expect(result.content[0].text).toContain("Moved");
            expect(result.content[0].text).toContain("Todo");
            expect(result.content[0].text).toContain("Done");

            // Verify the task is in Done
            const readResult = await readBoard({ path: "boards/move-test.md", compact: false });
            const doneSection = readResult.content[0].text.indexOf("## Done");
            const taskPos = readResult.content[0].text.indexOf("Move me");
            expect(taskPos).toBeGreaterThan(doneSection);
        });

        it("preserves task metadata during move", async () => {
            await createBoard({ board_name: "Meta Move", columns: ["Todo", "Done"] });
            await addToColumn({
                path: "boards/meta-move.md",
                column: "Todo",
                description: "Important task",
                completed: false,
                tags: ["urgent"],
                priority: "high",
                due_date: "2026-12-31",
            });

            await moveTask({
                path: "boards/meta-move.md",
                task: "Important",
                to_column: "Done",
            });

            const content = await readFile(join(TEST_VAULT, "boards", "meta-move.md"), "utf-8");
            expect(content).toContain("Important task");
        });

        it("errors on missing destination column", async () => {
            await createBoard({ board_name: "Err", columns: ["Todo", "Done"] });
            const result = await moveTask({
                path: "boards/err.md",
                task: "anything",
                to_column: "Nonexistent",
            });
            expect(result.isError).toBe(true);
        });

        it("errors on missing task", async () => {
            await createBoard({ board_name: "No Task", columns: ["Todo", "Done"] });
            const result = await moveTask({
                path: "boards/no-task.md",
                task: "nonexistent",
                to_column: "Done",
            });
            expect(result.isError).toBe(true);
        });

        it("notifies when task already in destination", async () => {
            await createBoard({ board_name: "Same", columns: ["Todo", "Done"] });
            await addToColumn({ path: "boards/same.md", column: "Todo", description: "Already here", completed: false });

            const result = await moveTask({
                path: "boards/same.md",
                task: "Already here",
                to_column: "Todo",
            });
            expect(result.content[0].text).toContain("already in column");
        });
    });

    // ─── add-to-column ───────────────────────────────────────────────

    describe("add-to-column", () => {
        it("adds a task to a column", async () => {
            await createBoard({ board_name: "Add Test", columns: ["Todo", "Done"] });

            const result = await addToColumn({
                path: "boards/add-test.md",
                column: "Todo",
                description: "New task",
                completed: false,
            });
            expect(result.content[0].text).toContain("Added task");
            expect(result.content[0].text).toContain("New task");
        });

        it("adds a task with metadata", async () => {
            await createBoard({ board_name: "Meta Add", columns: ["Todo"] });

            await addToColumn({
                path: "boards/meta-add.md",
                column: "Todo",
                description: "Priority task",
                completed: false,
                tags: ["work"],
                priority: "high",
                due_date: "2026-11-01",
            });

            const content = await readFile(join(TEST_VAULT, "boards", "meta-add.md"), "utf-8");
            expect(content).toContain("Priority task");
        });

        it("errors on missing column", async () => {
            await createBoard({ board_name: "No Col", columns: ["Todo"] });
            const result = await addToColumn({
                path: "boards/no-col.md",
                column: "Nonexistent",
                description: "Task",
                completed: false,
            });
            expect(result.isError).toBe(true);
        });

        it("adds at specific position", async () => {
            await createBoard({ board_name: "Position", columns: ["Todo"] });
            await addToColumn({ path: "boards/position.md", column: "Todo", description: "First", completed: false });
            await addToColumn({ path: "boards/position.md", column: "Todo", description: "Second", completed: false });
            await addToColumn({
                path: "boards/position.md",
                column: "Todo",
                description: "Inserted",
                completed: false,
                position: 1,
            });

            const readResult = await readBoard({ path: "boards/position.md", compact: false });
            const text = readResult.content[0].text;
            const firstPos = text.indexOf("First");
            const insertedPos = text.indexOf("Inserted");
            const secondPos = text.indexOf("Second");
            expect(insertedPos).toBeGreaterThan(firstPos);
            expect(insertedPos).toBeLessThan(secondPos);
        });
    });

    // ─── archive-column ──────────────────────────────────────────────

    describe("archive-column", () => {
        it("archives tasks from a column", async () => {
            await createBoard({ board_name: "Archive Test", columns: ["Todo", "Done"] });
            await addToColumn({ path: "boards/archive-test.md", column: "Todo", description: "T1", completed: false });
            await addToColumn({ path: "boards/archive-test.md", column: "Todo", description: "T2", completed: false });

            const result = await archiveColumn({
                path: "boards/archive-test.md",
                column: "Todo",
                archive_name: "Archive",
                clear_after: true,
            });
            expect(result.content[0].text).toContain("Archived 2 task(s)");

            // Verify source is empty
            const readResult = await readBoard({ path: "boards/archive-test.md", compact: true });
            expect(readResult.content[0].text).toContain("Archive");
        });

        it("creates archive column if missing", async () => {
            const createResult = await createBoard({ board_name: "No Archive", columns: ["Todo"] });
            if (createResult.isError) {
                throw new Error(`createBoard failed: ${createResult.content[0].text}`);
            }

            const addResult = await addToColumn({ path: "boards/no-archive.md", column: "Todo", description: "Task", completed: false });
            if (addResult.isError) {
                throw new Error(`addToColumn failed: ${addResult.content[0].text}`);
            }

            const archiveResult = await archiveColumn({
                path: "boards/no-archive.md",
                column: "Todo",
                archive_name: "Archive",
                clear_after: true,
            });
            if (archiveResult.isError) {
                throw new Error(`Archive failed: ${archiveResult.content[0].text}`);
            }
            expect(archiveResult.content[0].text).toContain("Archived");

            const content = await readFile(join(TEST_VAULT, "boards", "no-archive.md"), "utf-8");
            expect(content).toContain("Archive");
        });

        it("errors on empty column", async () => {
            await createBoard({ board_name: "Empty", columns: ["Todo"] });
            const result = await archiveColumn({
                path: "boards/empty.md",
                column: "Todo",
                archive_name: "Archive",
                clear_after: true,
            });
            expect(result.content[0].text).toContain("already empty");
        });

        it("errors on missing column", async () => {
            await createBoard({ board_name: "Missing", columns: ["Todo"] });
            const result = await archiveColumn({
                path: "boards/missing.md",
                column: "Nonexistent",
                archive_name: "Archive",
                clear_after: true,
            });
            expect(result.isError).toBe(true);
        });
    });

    // ─── rename-column ───────────────────────────────────────────────

    describe("rename-column", () => {
        it("renames a column", async () => {
            await createBoard({ board_name: "Rename Test", columns: ["Todo", "Done"] });

            const result = await renameColumn({
                path: "boards/rename-test.md",
                column: "Todo",
                new_name: "Backlog",
            });
            expect(result.content[0].text).toContain("Renamed column");
            expect(result.content[0].text).toContain("Todo");
            expect(result.content[0].text).toContain("Backlog");
        });

        it("errors on missing column", async () => {
            await createBoard({ board_name: "No Rename", columns: ["Todo"] });
            const result = await renameColumn({
                path: "boards/no-rename.md",
                column: "Nonexistent",
                new_name: "New",
            });
            expect(result.isError).toBe(true);
        });

        it("errors on name conflict", async () => {
            await createBoard({ board_name: "Conflict", columns: ["Todo", "Done"] });
            const result = await renameColumn({
                path: "boards/conflict.md",
                column: "Todo",
                new_name: "Done",
            });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain("already exists");
        });

        it("is case-insensitive for column matching", async () => {
            await createBoard({ board_name: "Case", columns: ["Todo", "Done"] });
            const result = await renameColumn({
                path: "boards/case.md",
                column: "todo",
                new_name: "Backlog",
            });
            expect(result.content[0].text).toContain("Renamed");
        });
    });

    // ─── reorder-columns ─────────────────────────────────────────────

    describe("reorder-columns", () => {
        it("reorders columns", async () => {
            await createBoard({ board_name: "Reorder Test", columns: ["A", "B", "C"] });

            const result = await reorderColumns({
                path: "boards/reorder-test.md",
                columns: ["C", "A", "B"],
            });
            expect(result.content[0].text).toContain("C -> A -> B");
        });

        it("errors on missing column", async () => {
            await createBoard({ board_name: "Bad Reorder", columns: ["A", "B"] });
            const result = await reorderColumns({
                path: "boards/bad-reorder.md",
                columns: ["A", "Nonexistent"],
            });
            expect(result.isError).toBe(true);
        });

        it("errors on empty columns array", async () => {
            await createBoard({ board_name: "Empty Reorder", columns: ["A"] });
            const result = await reorderColumns({
                path: "boards/empty-reorder.md",
                columns: [],
            });
            expect(result.isError).toBe(true);
        });
    });
});
