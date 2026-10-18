/**
 * Tests for append-note tool handler.
 * Covers append, prepend, section-based insertion, auto-newline, and error paths.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { initVault } from "../utils/vault.js";
import { handler } from "./append-note.js";
import { cancelHiveRegen } from "./hive-auto-regen.js";

let testCounter = 0;
let TEST_VAULT = "";

describe("append-note tool", () => {
    beforeEach(async () => {
        cancelHiveRegen();
        TEST_VAULT = join(process.cwd(), `test-vault-append-note-${process.pid}-${testCounter++}`);
        await rm(TEST_VAULT, { recursive: true, force: true });
        await mkdir(TEST_VAULT, { recursive: true });
        await mkdir(join(TEST_VAULT, "notes"), { recursive: true });

        await writeFile(
            join(TEST_VAULT, "notes", "test.md"),
            "# Test Note\n\nInitial content.\n\n## Section One\n\nContent in section one.\n\n## Section Two\n\nContent in section two.",
        );

        process.env.NOTES_VAULT_PATH = TEST_VAULT;
        initVault();
    });

    afterEach(async () => {
        cancelHiveRegen();
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

    describe("basic append", () => {
        it("appends content to end of file", async () => {
            const result = await handler({
                path: "notes/test.md",
                content: "Appended text",
                prepend: false,
                auto_newline: true,
            });
            expect(result.content[0].text).toContain("appended");
            const content = await readFile(join(TEST_VAULT, "notes", "test.md"), "utf-8");
            expect(content).toContain("Appended text");
        });

        it("returns error when note not found", async () => {
            const result = await handler({
                path: "notes/nonexistent.md",
                content: "text",
                prepend: false,
                auto_newline: true,
            }) as { content: { type: "text"; text: string }[]; isError?: boolean };
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain("not found");
        });

        it("auto-appends .md extension", async () => {
            const result = await handler({
                path: "notes/test",
                content: "text",
                prepend: false,
                auto_newline: true,
            });
            expect(result.content[0].text).toContain("appended");
        });
    });

    describe("prepend mode", () => {
        it("prepends content to beginning of file", async () => {
            const result = await handler({
                path: "notes/test.md",
                content: "Prepended text",
                prepend: true,
                auto_newline: true,
            });
            expect(result.content[0].text).toContain("prepended");
            const content = await readFile(join(TEST_VAULT, "notes", "test.md"), "utf-8");
            expect(content.indexOf("Prepended text")).toBeLessThan(content.indexOf("Initial content"));
        });

        it("adds proper newline separation in prepend", async () => {
            await handler({
                path: "notes/test.md",
                content: "Prepended",
                prepend: true,
                auto_newline: true,
            });
            const content = await readFile(join(TEST_VAULT, "notes", "test.md"), "utf-8");
            // Should have newline after prepended content
            expect(content).toMatch(/Prepended\n/);
        });
    });

    describe("section-based insertion", () => {
        it("inserts content after heading", async () => {
            const result = await handler({
                path: "notes/test.md",
                content: "New item in section one",
                prepend: false,
                after_heading: "Section One",
                auto_newline: true,
            });
            expect(result.content[0].text).toContain("after heading");
            const content = await readFile(join(TEST_VAULT, "notes", "test.md"), "utf-8");
            const sectionOnePos = content.indexOf("## Section One");
            const newItemPos = content.indexOf("New item in section one");
            const sectionTwoPos = content.indexOf("## Section Two");
            expect(newItemPos).toBeGreaterThan(sectionOnePos);
            expect(newItemPos).toBeLessThan(sectionTwoPos);
        });

        it("inserts content before heading", async () => {
            const result = await handler({
                path: "notes/test.md",
                content: "Content before section two",
                prepend: false,
                before_heading: "Section Two",
                auto_newline: true,
            });
            expect(result.content[0].text).toContain("before heading");
            const content = await readFile(join(TEST_VAULT, "notes", "test.md"), "utf-8");
            const beforePos = content.indexOf("Content before section two");
            const sectionTwoPos = content.indexOf("## Section Two");
            expect(beforePos).toBeLessThan(sectionTwoPos);
        });

        it("returns error when heading not found", async () => {
            const result = await handler({
                path: "notes/test.md",
                content: "text",
                prepend: false,
                after_heading: "Nonexistent Section",
                auto_newline: true,
            }) as { content: { type: "text"; text: string }[]; isError?: boolean };
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain("not found");
        });

        it("inserts at end of section (before next heading)", async () => {
            await handler({
                path: "notes/test.md",
                content: "Inserted at end of section one",
                prepend: false,
                after_heading: "Section One",
                auto_newline: true,
            });
            const content = await readFile(join(TEST_VAULT, "notes", "test.md"), "utf-8");
            // Should be after "Content in section one" but before "## Section Two"
            const contentInSectionOne = content.indexOf("Content in section one");
            const inserted = content.indexOf("Inserted at end of section one");
            const sectionTwo = content.indexOf("## Section Two");
            expect(inserted).toBeGreaterThan(contentInSectionOne);
            expect(inserted).toBeLessThan(sectionTwo);
        });
    });

    describe("auto-newline behavior", () => {
        it("ensures newline separation when auto_newline=true", async () => {
            await writeFile(join(TEST_VAULT, "notes", "no-newline.md"), "Content without newline");
            await handler({
                path: "notes/no-newline.md",
                content: "Appended",
                prepend: false,
                auto_newline: true,
            });
            const content = await readFile(join(TEST_VAULT, "notes", "no-newline.md"), "utf-8");
            expect(content).toContain("\nAppended");
        });

        it("does not add extra newlines when auto_newline=false", async () => {
            await writeFile(join(TEST_VAULT, "notes", "exact.md"), "Exact content");
            await handler({
                path: "notes/exact.md",
                content: "Appended",
                prepend: false,
                auto_newline: false,
            });
            const content = await readFile(join(TEST_VAULT, "notes", "exact.md"), "utf-8");
            expect(content).toBe("Exact contentAppended");
        });
    });

    describe("content size validation", () => {
        it("rejects content exceeding size limit", async () => {
            const hugeContent = "x".repeat(1_000_000);
            const result = await handler({
                path: "notes/test.md",
                content: hugeContent,
                prepend: false,
                auto_newline: true,
            }) as { content: { type: "text"; text: string }[]; isError?: boolean };
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain("Error");
        });
    });
});
