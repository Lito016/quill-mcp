/**
 * Tests for the query-tasks tool handler.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initVault } from "../utils/vault.js";
import { handler } from "./query-tasks.js";
import { taskIndex } from "../utils/task-index.js";

let testCounter = 0;
let TEST_VAULT = "";

describe("query-tasks tool", () => {
    beforeEach(async () => {
        TEST_VAULT = join(process.cwd(), `test-vault-query-tasks-${process.pid}-${testCounter++}`);
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

    it("returns tasks matching text query", async () => {
        await writeFile(
            join(TEST_VAULT, "tasks.md"),
            "- [ ] Buy groceries\n- [ ] Clean house\n- [ ] Buy books\n",
        );

        const result = await handler({
            query: "buy",
            any_tag: false,
            sort: "file",
            offset: 0,
            summary: false,
        });

        expect(result.content[0].text).toContain("2 task(s)");
        expect(result.content[0].text).toContain("Buy groceries");
        expect(result.content[0].text).toContain("Buy books");
    });

    it("includes summary when requested", async () => {
        await writeFile(
            join(TEST_VAULT, "tasks.md"),
            "- [ ] Pending one\n- [x] Complete one\n- [ ] Pending two\n",
        );

        taskIndex.markDirty();
        const result = await handler({
            any_tag: false,
            sort: "file",
            offset: 0,
            summary: true,
        });

        expect(result.content[0].text).toContain("Summary");
        expect(result.content[0].text).toContain("Pending: 2");
        expect(result.content[0].text).toContain("Complete: 1");
    });

    it("handles OR tag logic with any_tag", async () => {
        await writeFile(
            join(TEST_VAULT, "tasks.md"),
            "- [ ] Work task \u{1F3F7}\u{FE0F} work\n- [ ] Home task \u{1F3F7}\u{FE0F} home\n- [ ] Both \u{1F3F7}\u{FE0F} work,home\n",
        );

        taskIndex.markDirty();
        const result = await handler({
            tags: ["work", "home"],
            any_tag: true,
            sort: "file",
            offset: 0,
            summary: false,
        });

        expect(result.content[0].text).toContain("3 task(s)");
    });

    it("handles AND tag logic without any_tag", async () => {
        await writeFile(
            join(TEST_VAULT, "tasks.md"),
            "- [ ] Work task \u{1F3F7}\u{FE0F} work\n- [ ] Home task \u{1F3F7}\u{FE0F} home\n- [ ] Both \u{1F3F7}\u{FE0F} work,home\n",
        );

        taskIndex.markDirty();
        const result = await handler({
            tags: ["work", "home"],
            any_tag: false,
            sort: "file",
            offset: 0,
            summary: false,
        });

        expect(result.content[0].text).toContain("1 task(s)");
        expect(result.content[0].text).toContain("Both");
    });

    it("detects overdue tasks", async () => {
        // Use a date in the past
        await writeFile(
            join(TEST_VAULT, "tasks.md"),
            "- [ ] Overdue \u{1F4C5} 2020-01-01\n- [ ] Future \u{1F4C5} 2099-12-31\n- [ ] No date\n",
        );

        taskIndex.markDirty();
        const result = await handler({
            overdue: true,
            any_tag: false,
            sort: "file",
            offset: 0,
            summary: false,
        });

        expect(result.content[0].text).toContain("1 task(s)");
        expect(result.content[0].text).toContain("Overdue");
    });

    it("sorts by description", async () => {
        await writeFile(
            join(TEST_VAULT, "tasks.md"),
            "- [ ] Cherry\n- [ ] Apple\n- [ ] Banana\n",
        );

        taskIndex.markDirty();
        const result = await handler({
            any_tag: false,
            sort: "description",
            offset: 0,
            summary: false,
        });

        const text = result.content[0].text;
        const applePos = text.indexOf("Apple");
        const bananaPos = text.indexOf("Banana");
        const cherryPos = text.indexOf("Cherry");
        expect(applePos).toBeLessThan(bananaPos);
        expect(bananaPos).toBeLessThan(cherryPos);
    });

    it("returns message when no tasks match", async () => {
        await writeFile(join(TEST_VAULT, "tasks.md"), "- [ ] Existing task\n");

        taskIndex.markDirty();
        const result = await handler({
            query: "nonexistent",
            any_tag: false,
            sort: "file",
            offset: 0,
            summary: false,
        });

        expect(result.content[0].text).toContain("No tasks match");
    });

    it("combines multiple filters", async () => {
        await writeFile(
            join(TEST_VAULT, "tasks.md"),
            [
                "- [ ] High work \u{1F3F7}\u{FE0F} work \u{1F4CC} high",
                "- [ ] Low work \u{1F3F7}\u{FE0F} work \u{1F4CC} low",
                "- [ ] High home \u{1F3F7}\u{FE0F} home \u{1F4CC} high",
            ].join("\n"),
        );

        taskIndex.markDirty();
        const result = await handler({
            tags: ["work"],
            priority: "high",
            any_tag: false,
            sort: "file",
            offset: 0,
            summary: false,
        });

        expect(result.content[0].text).toContain("1 task(s)");
        expect(result.content[0].text).toContain("High work");
    });

    it("supports pagination", async () => {
        const tasks = Array.from({ length: 10 }, (_, i) => `- [ ] Task ${i + 1}`).join("\n");
        await writeFile(join(TEST_VAULT, "tasks.md"), tasks);

        taskIndex.markDirty();
        const result = await handler({
            any_tag: false,
            sort: "file",
            limit: 3,
            offset: 0,
            summary: false,
        });

        expect(result.content[0].text).toContain("Showing 3 of 10");
    });

    it("summary shows overdue count", async () => {
        await writeFile(
            join(TEST_VAULT, "tasks.md"),
            "- [ ] Overdue \u{1F4C5} 2020-01-01\n- [ ] Not overdue \u{1F4C5} 2099-12-31\n",
        );

        taskIndex.markDirty();
        const result = await handler({
            any_tag: false,
            sort: "file",
            offset: 0,
            summary: true,
        });

        expect(result.content[0].text).toContain("Overdue: 1");
    });
});
