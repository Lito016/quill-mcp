/**
 * Tests for the Kanban board index utility.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initVault } from "./vault.js";
import { kanbanIndex } from "./kanban-index.js";

let testCounter = 0;
let TEST_VAULT = "";

describe("kanban-index", () => {
    beforeEach(async () => {
        TEST_VAULT = join(process.cwd(), `test-vault-kanban-idx-${process.pid}-${testCounter++}`);
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

    it("finds boards in boards/ directory", async () => {
        await mkdir(join(TEST_VAULT, "boards"), { recursive: true });
        await writeFile(
            join(TEST_VAULT, "boards", "project.md"),
            `---
type: kanban
columns: [Todo, Done]
---
# Project Board

## Todo
- [ ] Task 1

## Done
- [x] Task 2
`,
        );

        const boards = await kanbanIndex.getAllBoards();
        expect(boards).toHaveLength(1);
        expect(boards[0].name).toBe("Project Board");
        expect(boards[0].filePath).toBe("boards/project.md");
    });

    it("finds boards by frontmatter type", async () => {
        await writeFile(
            join(TEST_VAULT, "my-board.md"),
            `---
type: kanban
columns: [Back, Front]
---
# My Board

## Back
- [ ] Backend task

## Front
- [ ] Frontend task
`,
        );

        const boards = await kanbanIndex.getAllBoards();
        expect(boards).toHaveLength(1);
        expect(boards[0].filePath).toBe("my-board.md");
    });

    it("detects boards by heuristic (multiple H2 + checkboxes)", async () => {
        await writeFile(
            join(TEST_VAULT, "implicit-board.md"),
            `## Todo
- [ ] Task 1

## In Progress
- [ ] Task 2

## Done
- [x] Task 3
`,
        );

        const boards = await kanbanIndex.getAllBoards();
        expect(boards).toHaveLength(1);
    });

    it("ignores regular notes", async () => {
        await writeFile(join(TEST_VAULT, "regular-note.md"), "# Just a Note\n\nSome content.\n");

        const boards = await kanbanIndex.getAllBoards();
        expect(boards).toHaveLength(0);
    });

    it("ignores single-column files", async () => {
        await writeFile(
            join(TEST_VAULT, "tasks.md"),
            `## Tasks
- [ ] Task 1
- [ ] Task 2
`,
        );

        const boards = await kanbanIndex.getAllBoards();
        expect(boards).toHaveLength(0);
    });

    it("returns board by file path", async () => {
        await mkdir(join(TEST_VAULT, "boards"), { recursive: true });
        await writeFile(
            join(TEST_VAULT, "boards", "test.md"),
            `---
type: kanban
---
## Todo
- [ ] Task
`,
        );

        const board = await kanbanIndex.getBoard("boards/test.md");
        expect(board).toBeDefined();
        expect(board!.name).toBe("test");
    });

    it("returns undefined for non-existent board", async () => {
        const board = await kanbanIndex.getBoard("nonexistent.md");
        expect(board).toBeUndefined();
    });

    it("provides statistics", async () => {
        await mkdir(join(TEST_VAULT, "boards"), { recursive: true });
        await writeFile(
            join(TEST_VAULT, "boards", "stats.md"),
            `---
type: kanban
---
## Todo
- [ ] Task 1
- [ ] Task 2

## Done
- [x] Task 3
`,
        );

        const stats = await kanbanIndex.getStats();
        expect(stats.totalBoards).toBe(1);
        expect(stats.totalColumns).toBe(2);
        expect(stats.totalTasks).toBe(3);
    });

    it("invalidates path correctly", async () => {
        // Use a non-boards/ path so heuristic detection applies
        await writeFile(
            join(TEST_VAULT, "inv-board.md"),
            `---
type: kanban
---
## Todo
- [ ] Task
`,
        );

        // First sync
        let boards = await kanbanIndex.getAllBoards();
        expect(boards).toHaveLength(1);

        // Invalidate and update file to no longer be a board
        kanbanIndex.invalidatePath("inv-board.md");
        await writeFile(join(TEST_VAULT, "inv-board.md"), "# Not a board anymore\n");

        boards = await kanbanIndex.getAllBoards();
        expect(boards).toHaveLength(0);
    });

    it("finds multiple boards across directories", async () => {
        await mkdir(join(TEST_VAULT, "boards"), { recursive: true });
        await mkdir(join(TEST_VAULT, "projects"), { recursive: true });

        await writeFile(
            join(TEST_VAULT, "boards", "main.md"),
            `---
type: kanban
---
## Todo
- [ ] Task A
`,
        );

        await writeFile(
            join(TEST_VAULT, "projects", "side.md"),
            `---
type: kanban
---
## Backlog
- [ ] Task B
`,
        );

        const boards = await kanbanIndex.getAllBoards();
        expect(boards).toHaveLength(2);
    });
});
