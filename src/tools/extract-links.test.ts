/**
 * Tests for extract-links tool handler.
 * Covers single-file, bulk, JSON output, health checks, and error paths.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initVault } from "../utils/vault.js";
import { handler } from "./extract-links.js";
import { cancelHiveRegen } from "./hive-auto-regen.js";
import type { WikiLink } from "../utils/links.js";

let testCounter = 0;
let TEST_VAULT = "";

describe("extract-links tool", () => {
    beforeEach(async () => {
        cancelHiveRegen();
        TEST_VAULT = join(process.cwd(), `test-vault-extract-links-${process.pid}-${testCounter++}`);
        await rm(TEST_VAULT, { recursive: true, force: true });
        await mkdir(TEST_VAULT, { recursive: true });
        await mkdir(join(TEST_VAULT, "notes"), { recursive: true });
        await mkdir(join(TEST_VAULT, "notes", "sub"), { recursive: true });
        // Create a directory with extension for bulk mode testing (handler adds .md if no ext)
        await mkdir(join(TEST_VAULT, "scan.dir"), { recursive: true });

        // Note with various link types
        await writeFile(
            join(TEST_VAULT, "notes", "rich-links.md"),
            [
                "---",
                "title: Rich Links",
                "---",
                "",
                "Simple: [[target-note]]",
                "Display: [[target-note|click here]]",
                "Heading: [[target-note#section]]",
                "Block: [[target-note#^block1]]",
                "Embed: ![[embedded-note]]",
                "Markdown: [external](https://example.com)",
                "Local md: [local](other-note.md)",
                "Md embed: ![img](image-note.md)",
            ].join("\n"),
        );

        // Note with no links
        await writeFile(join(TEST_VAULT, "notes", "no-links.md"), "Just plain text with no links at all.\n");

        // Note in subdirectory
        await writeFile(
            join(TEST_VAULT, "notes", "sub", "deep.md"),
            "See [[target-note]] and [[another]]\n",
        );
        // Note in scan.dir for bulk testing
        await writeFile(
            join(TEST_VAULT, "scan.dir", "bulk-test.md"),
            "Bulk test [[target-note]]\n",
        );

        // Target note that exists (for health check)
        await writeFile(join(TEST_VAULT, "notes", "target-note.md"), "# Target\n\nContent\n");

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

    describe("single file mode", () => {
        it("extracts all link types in text output", async () => {
            const result = await handler({
                path: "notes/rich-links.md",
                bulk: false,
                check_health: false,
                json: false,
            });
            const text = result.content[0].text;
            expect(text).toContain("[[target-note]]");
            expect(text).toContain("[[target-note|click here]]");
            expect(text).toContain("[[target-note#section]]");
            expect(text).toContain("[[target-note#^block1]]");
            expect(text).toContain("![[embedded-note]]");
            // Markdown links are extracted
            expect(text).toContain("[local](other-note.md)");
            expect(text).toContain("![img](image-note.md)");
        });

        it("returns JSON output when json=true", async () => {
            const result = await handler({
                path: "notes/rich-links.md",
                bulk: false,
                check_health: false,
                json: true,
            });
            const parsed = JSON.parse(result.content[0].text);
            expect(parsed.file).toBe("notes/rich-links.md");
            expect(parsed.wiki.length).toBeGreaterThanOrEqual(4);
            expect(parsed.markdown.length).toBeGreaterThanOrEqual(2);
            expect(parsed.total).toBe(parsed.wiki.length + parsed.markdown.length);

            // Check wiki link structure
            const simple = parsed.wiki.find((l: WikiLink) => l.target === "target-note" && !l.heading && !l.blockId);
            expect(simple).toBeDefined();
            expect(simple.isEmbed).toBe(false);

            const heading = parsed.wiki.find((l: WikiLink) => l.heading === "section");
            expect(heading).toBeDefined();

            const block = parsed.wiki.find((l: WikiLink) => l.blockId === "block1");
            expect(block).toBeDefined();

            const embed = parsed.wiki.find((l: WikiLink) => l.isEmbed === true);
            expect(embed).toBeDefined();
        });

        it("reports no links found", async () => {
            const result = await handler({
                path: "notes/no-links.md",
                bulk: false,
                check_health: false,
                json: false,
            });
            expect(result.content[0].text).toContain("No links found");
        });

        it("returns error for missing path", async () => {
            const result = await handler({
                path: "notes/nonexistent.md",
                bulk: false,
                check_health: false,
                json: false,
            });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain("not found");
        });

        it("auto-appends .md extension", async () => {
            const result = await handler({
                path: "notes/no-links",
                bulk: false,
                check_health: false,
                json: false,
            });
            expect(result.content[0].text).toContain("No links found");
        });
    });

    describe("health check", () => {
        it("flags broken wiki links", async () => {
            const result = await handler({
                path: "notes/rich-links.md",
                bulk: false,
                check_health: true,
                json: false,
            });
            const text = result.content[0].text;
            // target-note exists, but embedded-note does not
            expect(text).toContain("BROKEN");
            expect(text).toContain("embedded-note");
        });

        it("does not flag http or anchor-only markdown links as broken", async () => {
            const result = await handler({
                path: "notes/rich-links.md",
                bulk: false,
                check_health: true,
                json: false,
            });
            const text = result.content[0].text;
            // https://example.com should never be checked
            expect(text).not.toContain("example.com⚠️");
            expect(text).not.toContain("https://example.com");
        });
    });

    describe("bulk mode", () => {
        it("scans directory recursively", async () => {
            // Bulk mode requires a directory path with extension (handler adds .md otherwise)
            const result = await handler({
                path: "scan.dir",
                bulk: true,
                check_health: false,
                json: false,
            });
            const text = result.content[0].text;
            expect(text).toContain("bulk-test.md");
        });

        it("returns JSON in bulk mode", async () => {
            const result = await handler({
                path: "scan.dir",
                bulk: true,
                check_health: false,
                json: true,
            });
            const parsed = JSON.parse(result.content[0].text);
            expect(Array.isArray(parsed)).toBe(true);
            expect(parsed.length).toBeGreaterThanOrEqual(1);
            const bulk = parsed.find((r: { file: string }) => r.file.includes("bulk-test.md"));
            expect(bulk).toBeDefined();
            expect(bulk.wiki.length).toBeGreaterThanOrEqual(1);
        });

        it("skips .trash and .quill-sessions directories", async () => {
            await mkdir(join(TEST_VAULT, "scan.dir", ".trash"), { recursive: true });
            await writeFile(
                join(TEST_VAULT, "scan.dir", ".trash", "deleted.md"),
                "See [[secret-target]]",
            );
            const result = await handler({
                path: "scan.dir",
                bulk: true,
                check_health: false,
                json: true,
            });
            const parsed = JSON.parse(result.content[0].text);
            const trashed = parsed.find((r: { file: string }) => r.file.includes(".trash"));
            expect(trashed).toBeUndefined();
        });
    });
});
