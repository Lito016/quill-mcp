/**
 * Tests for the complete-recurring tool handler.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { initVault } from "../utils/vault.js";
import { handler } from "./complete-recurring.js";
import { taskIndex } from "../utils/task-index.js";

let testCounter = 0;
let TEST_VAULT = "";

describe("complete-recurring tool", () => {
    beforeEach(async () => {
        TEST_VAULT = join(process.cwd(), `test-vault-complete-recurring-${process.pid}-${testCounter++}`);
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

    it("completes a daily recurring task and creates next occurrence", async () => {
        await writeFile(join(TEST_VAULT, "tasks.md"), "- [ ] Buy groceries \u{1F504} daily\n");

        const result = await handler({
            note: "tasks.md",
            line: 1,
        });

        expect(result.content[0].text).toContain("completed");
        expect(result.content[0].text).toContain("Next occurrence");

        const content = await readFile(join(TEST_VAULT, "tasks.md"), "utf-8");
        const lines = content.split("\n");
        // First line should be completed
        expect(lines[0]).toContain("- [x] Buy groceries");
        // Second line should be the new pending task
        expect(lines[1]).toContain("- [ ] Buy groceries");
        expect(lines[1]).toContain("\u{1F504} daily");
    });

    it("completes a weekly recurring task by search", async () => {
        await writeFile(
            join(TEST_VAULT, "tasks.md"),
            "- [ ] Team standup \u{1F504} weekly:mon,wed,fri\n- [ ] Other task\n",
        );

        const result = await handler({
            note: "tasks.md",
            search: "standup",
        });

        expect(result.content[0].text).toContain("completed");

        const content = await readFile(join(TEST_VAULT, "tasks.md"), "utf-8");
        expect(content).toContain("- [x] Team standup");
        expect(content).toContain("- [ ] Team standup");
    });

    it("creates recurrence state entry", async () => {
        await writeFile(join(TEST_VAULT, "tasks.md"), "- [ ] Daily task \u{1F504} daily\n");

        await handler({ note: "tasks.md", line: 1 });

        // Check state file was created
        const stateContent = await readFile(join(TEST_VAULT, ".quill-recurrence-state.json"), "utf-8");
        const state = JSON.parse(stateContent);
        expect(state.entries).toHaveLength(1);
        expect(state.entries[0].pattern).toBe("daily");
        expect(state.entries[0].paused).toBe(false);
    });

    it("returns error for non-recurring task", async () => {
        await writeFile(join(TEST_VAULT, "tasks.md"), "- [ ] Regular task\n");

        const result = await handler({
            note: "tasks.md",
            line: 1,
        }) as { content: { type: "text"; text: string }[]; isError?: boolean };

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("does not have a recurrence pattern");
    });

    it("returns error when note not found", async () => {
        const result = await handler({
            note: "nonexistent.md",
            line: 1,
        }) as { content: { type: "text"; text: string }[]; isError?: boolean };

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("not found");
    });

    it("returns error when neither line nor search provided", async () => {
        const result = await handler({
            note: "tasks.md",
        }) as { content: { type: "text"; text: string }[]; isError?: boolean };

        expect(result.isError).toBe(true);
    });

    it("returns error when line is out of range", async () => {
        await writeFile(join(TEST_VAULT, "tasks.md"), "- [ ] Task \u{1F504} daily\n");

        const result = await handler({
            note: "tasks.md",
            line: 99,
        }) as { content: { type: "text"; text: string }[]; isError?: boolean };

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("out of range");
    });

    it("returns error when search finds no recurring task", async () => {
        await writeFile(join(TEST_VAULT, "tasks.md"), "- [ ] Regular task\n");

        const result = await handler({
            note: "tasks.md",
            search: "nonexistent",
        }) as { content: { type: "text"; text: string }[]; isError?: boolean };

        expect(result.isError).toBe(true);
    });

    it("preserves indentation", async () => {
        await writeFile(join(TEST_VAULT, "tasks.md"), "  - [ ] Indented task \u{1F504} daily\n");

        await handler({ note: "tasks.md", line: 1 });

        const content = await readFile(join(TEST_VAULT, "tasks.md"), "utf-8");
        const lines = content.split("\n");
        expect(lines[0]).toMatch(/^\s+- \[x\]/);
        expect(lines[1]).toMatch(/^\s+- \[ \]/);
    });
});
