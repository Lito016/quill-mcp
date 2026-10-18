/**
 * Tests for the complete-task tool handler.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { initVault } from "../utils/vault.js";
import { handler } from "./complete-task.js";
import { taskIndex } from "../utils/task-index.js";

let testCounter = 0;
let TEST_VAULT = "";

describe("complete-task tool", () => {
    beforeEach(async () => {
        TEST_VAULT = join(process.cwd(), `test-vault-complete-task-${process.pid}-${testCounter++}`);
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

    it("completes a task by line number", async () => {
        await writeFile(join(TEST_VAULT, "tasks.md"), "- [ ] Task one\n- [ ] Task two\n- [ ] Task three\n");

        const result = await handler({
            note: "tasks.md",
            line: 2,
            action: "complete",
        });

        expect(result.content[0].text).toContain("completed");
        const content = await readFile(join(TEST_VAULT, "tasks.md"), "utf-8");
        expect(content).toContain("- [ ] Task one");
        expect(content).toContain("- [x] Task two");
        expect(content).toContain("- [ ] Task three");
    });

    it("reopens a completed task", async () => {
        await writeFile(join(TEST_VAULT, "tasks.md"), "- [x] Done task\n");

        const result = await handler({
            note: "tasks.md",
            line: 1,
            action: "reopen",
        });

        expect(result.content[0].text).toContain("reopened");
        const content = await readFile(join(TEST_VAULT, "tasks.md"), "utf-8");
        expect(content).toContain("- [ ] Done task");
    });

    it("completes a task by search text", async () => {
        await writeFile(
            join(TEST_VAULT, "tasks.md"),
            "- [ ] Buy groceries\n- [ ] Clean house\n- [x] Already done\n",
        );

        const result = await handler({
            note: "tasks.md",
            search: "clean",
            action: "complete",
        });

        expect(result.content[0].text).toContain("completed");
        const content = await readFile(join(TEST_VAULT, "tasks.md"), "utf-8");
        expect(content).toContain("- [ ] Buy groceries");
        expect(content).toContain("- [x] Clean house");
    });

    it("search skips already completed tasks when completing", async () => {
        await writeFile(
            join(TEST_VAULT, "tasks.md"),
            "- [x] Buy groceries\n- [ ] Buy groceries (again)\n",
        );

        const result = await handler({
            note: "tasks.md",
            search: "buy groceries",
            action: "complete",
        });

        expect(result.content[0].text).toContain("completed");
        const content = await readFile(join(TEST_VAULT, "tasks.md"), "utf-8");
        // First one should stay completed, second should now be completed too
        expect(content).toContain("- [x] Buy groceries\n");
        expect(content).toContain("- [x] Buy groceries (again)");
    });

    it("returns error when note not found", async () => {
        const result = await handler({
            note: "nonexistent.md",
            line: 1,
            action: "complete",
        }) as { content: { type: "text"; text: string }[]; isError?: boolean };

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("not found");
    });

    it("returns error when line is out of range", async () => {
        await writeFile(join(TEST_VAULT, "tasks.md"), "- [ ] Task\n");

        const result = await handler({
            note: "tasks.md",
            line: 100,
            action: "complete",
        }) as { content: { type: "text"; text: string }[]; isError?: boolean };

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("out of range");
    });

    it("returns error when line is not a task", async () => {
        await writeFile(join(TEST_VAULT, "tasks.md"), "# Not a task\n");

        const result = await handler({
            note: "tasks.md",
            line: 1,
            action: "complete",
        }) as { content: { type: "text"; text: string }[]; isError?: boolean };

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("not a task");
    });

    it("returns error when search finds no match", async () => {
        await writeFile(join(TEST_VAULT, "tasks.md"), "- [ ] Buy groceries\n");

        const result = await handler({
            note: "tasks.md",
            search: "nonexistent task",
            action: "complete",
        }) as { content: { type: "text"; text: string }[]; isError?: boolean };

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("No");
    });

    it("returns error when neither line nor search provided", async () => {
        await writeFile(join(TEST_VAULT, "tasks.md"), "- [ ] Task\n");

        const result = await handler({
            note: "tasks.md",
            action: "complete",
        }) as { content: { type: "text"; text: string }[]; isError?: boolean };

        expect(result.isError).toBe(true);
    });

    it("preserves indentation when completing", async () => {
        await writeFile(join(TEST_VAULT, "tasks.md"), "  - [ ] Indented task\n");

        await handler({
            note: "tasks.md",
            line: 1,
            action: "complete",
        });

        const content = await readFile(join(TEST_VAULT, "tasks.md"), "utf-8");
        expect(content).toContain("  - [x] Indented task");
    });

    it("auto-appends .md extension", async () => {
        await writeFile(join(TEST_VAULT, "tasks.md"), "- [ ] Task\n");

        const result = await handler({
            note: "tasks",
            line: 1,
            action: "complete",
        });

        expect(result.content[0].text).toContain("completed");
    });
});
