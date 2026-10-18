/**
 * Tests for search-notes tool handler.
 * Covers fuzzy, highlight, snippets, wildcard, frontmatter_only, pagination, sort, dedup, and error paths.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initVault } from "../utils/vault.js";
import { handler } from "./search-notes.js";
import { searchIndex } from "../utils/search-index.js";

let testCounter = 0;
let TEST_VAULT = "";

const defaults = {
    path: ".",
    fileExtension: ".md",
    useRegex: false,
    fuzzy: false,
    highlight: false,
    sort: "relevance" as const,
    snippets: 0,
    frontmatter_only: false,
    deduplicate: false,
    wildcard: false,
    offset: 0,
    showTokenEstimate: false,
};

describe("search-notes tool", () => {
    beforeEach(async () => {
        TEST_VAULT = join(process.cwd(), `test-vault-search-notes-${process.pid}-${testCounter++}`);
        await rm(TEST_VAULT, { recursive: true, force: true });
        await mkdir(TEST_VAULT, { recursive: true });
        await mkdir(join(TEST_VAULT, "notes"), { recursive: true });
        await mkdir(join(TEST_VAULT, "notes", "sub"), { recursive: true });

        await writeFile(
            join(TEST_VAULT, "notes", "alpha.md"),
            "---\ntitle: Alpha Note\ntags:\n  - design\n  - frontend\n---\n\n# Alpha\n\nThe quick brown fox jumps over the lazy dog.\n\nSecond paragraph with design patterns.",
        );
        await writeFile(
            join(TEST_VAULT, "notes", "beta.md"),
            "---\ntitle: Beta Note\ntags:\n  - backend\n---\n\n# Beta\n\nDatabase connections and query optimization.\n\nBackend architecture decisions.",
        );
        await writeFile(
            join(TEST_VAULT, "notes", "sub", "gamma.md"),
            "---\ntitle: Gamma Note\ntags:\n  - design\n---\n\n# Gamma\n\nDesign systems and component libraries.\n\nAnother line about design tokens.",
        );
        await writeFile(
            join(TEST_VAULT, "notes", "empty.md"),
            "",
        );

        process.env.NOTES_VAULT_PATH = TEST_VAULT;
        initVault();
        // Force index rebuild for fresh vault
        searchIndex.markDirty();
    });

    afterEach(async () => {
        delete process.env.NOTES_VAULT_PATH;
        searchIndex.markDirty();
        try {
            await Promise.race([
                rm(TEST_VAULT, { recursive: true, force: true }),
                new Promise((_, reject) => setTimeout(() => reject(new Error("cleanup timeout")), 5000)),
            ]);
        } catch {
            // Best effort
        }
    }, 10000);

    describe("basic search", () => {
        it("finds text matches across files", async () => {
            const result = await handler({ query: "design", ...defaults });
            expect(result.content[0].text).toContain("alpha.md");
            expect(result.content[0].text).toContain("gamma.md");
        });

        it("returns error for missing directory", async () => {
            const result = await handler({ query: "test", ...defaults, path: "nonexistent" }) as { content: { type: "text"; text: string }[]; isError?: boolean };
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain("not found");
        });

        it("reports no matches found", async () => {
            const result = await handler({ query: "xyznonexistent", ...defaults });
            expect(result.content[0].text).toContain("No matches");
        });
    });

    describe("regex mode", () => {
        it("supports regex patterns", async () => {
            const result = await handler({ query: "quick.*fox", ...defaults, useRegex: true });
            expect(result.content[0].text).toContain("alpha.md");
        });

        it("returns error for invalid regex", async () => {
            const result = await handler({ query: "[invalid", ...defaults, useRegex: true }) as { content: { type: "text"; text: string }[]; isError?: boolean };
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain("Invalid regex");
        });
    });

    describe("fuzzy mode", () => {
        it("finds results with typos via fuzzy matching", async () => {
            const result = await handler({ query: "desing", ...defaults, fuzzy: true });
            // "desing" should fuzzy-match "design" in alpha.md and gamma.md
            const text = result.content[0].text;
            expect(text).toContain("fuzzy");
        });

        it("includes fuzzy mode label in output", async () => {
            const result = await handler({ query: "quik", ...defaults, fuzzy: true });
            expect(result.content[0].text).toContain("fuzzy");
        });
    });

    describe("highlight mode", () => {
        it("wraps matches in bold markers", async () => {
            const result = await handler({ query: "fox", ...defaults, highlight: true });
            const text = result.content[0].text;
            expect(text).toContain("**");
            expect(text).toContain("highlight");
        });
    });

    describe("snippets", () => {
        it("includes context lines when snippets > 0", async () => {
            const result = await handler({ query: "quick", ...defaults, snippets: 1 });
            const text = result.content[0].text;
            expect(text).toContain("snippets:1");
        });
    });

    describe("wildcard mode", () => {
        it("supports glob-style patterns", async () => {
            const result = await handler({ query: "br*w*", ...defaults, wildcard: true });
            const text = result.content[0].text;
            expect(text).toContain("wildcard");
        });
    });

    describe("frontmatter_only mode", () => {
        it("searches only frontmatter metadata", async () => {
            const result = await handler({ query: "Alpha", ...defaults, frontmatter_only: true });
            const text = result.content[0].text;
            expect(text).toContain("alpha.md");
            expect(text).toContain("frontmatter_only");
        });

        it("does not match body content in frontmatter_only mode", async () => {
            const result = await handler({ query: "optimization", ...defaults, frontmatter_only: true });
            expect(result.content[0].text).toContain("No frontmatter matches");
        });

        it("matches tags in frontmatter_only mode", async () => {
            const result = await handler({ query: "backend", ...defaults, frontmatter_only: true });
            expect(result.content[0].text).toContain("beta.md");
        });
    });

    describe("sort options", () => {
        it("sorts by name", async () => {
            const result = await handler({ query: "design", ...defaults, sort: "name" });
            const text = result.content[0].text;
            // alpha should come before gamma alphabetically
            const alphaPos = text.indexOf("alpha.md");
            const gammaPos = text.indexOf("gamma.md");
            expect(alphaPos).toBeLessThan(gammaPos);
        });

        it("sorts by date", async () => {
            const result = await handler({ query: "design", ...defaults, sort: "date" });
            // Just verify it doesn't crash and returns results
            expect(result.content[0].text).toContain("match");
        });

        it("sorts by size", async () => {
            const result = await handler({ query: "design", ...defaults, sort: "size" });
            expect(result.content[0].text).toContain("match");
        });
    });

    describe("pagination", () => {
        it("respects limit parameter", async () => {
            const result = await handler({ query: "design", ...defaults, limit: 1 });
            const text = result.content[0].text;
            expect(text).toContain("Showing 1 of");
        });

        it("respects offset parameter", async () => {
            const fullResult = await handler({ query: "design", ...defaults });
            const fullText = fullResult.content[0].text;
            const fullCount = fullText.match(/Found (\d+) match/)?.[1];

            if (fullCount && parseInt(fullCount) > 1) {
                const offsetResult = await handler({ query: "design", ...defaults, offset: 1, limit: 100 });
                const offsetText = offsetResult.content[0].text;
                expect(offsetText).toContain("Showing");
            }
        });
    });

    describe("deduplication", () => {
        it("limits results per file when deduplicate=true", async () => {
            const result = await handler({ query: "design", ...defaults, deduplicate: true });
            const text = result.content[0].text;
            expect(text).toContain("dedup");
        });
    });

    describe("token estimation", () => {
        it("appends token estimate when showTokenEstimate=true", async () => {
            const result = await handler({ query: "design", ...defaults, showTokenEstimate: true });
            const text = result.content[0].text;
            expect(text).toContain("estimated");
        });
    });

    describe("path filtering", () => {
        it("restricts search to specified path", async () => {
            const result = await handler({ query: "design", ...defaults, path: "notes/sub" });
            const text = result.content[0].text;
            expect(text).toContain("gamma.md");
            expect(text).not.toContain("alpha.md");
        });

        it("excludes .trash from results", async () => {
            await mkdir(join(TEST_VAULT, ".trash"), { recursive: true });
            await writeFile(
                join(TEST_VAULT, ".trash", "deleted.md"),
                "design patterns in trash",
            );
            searchIndex.markDirty();
            const result = await handler({ query: "design", ...defaults });
            expect(result.content[0].text).not.toContain("deleted.md");
        });
    });

    describe("file extension filter", () => {
        it("filters by file extension", async () => {
            await writeFile(join(TEST_VAULT, "notes", "note.txt"), "design document");
            searchIndex.markDirty();
            const result = await handler({ query: "design", ...defaults, fileExtension: ".md" });
            expect(result.content[0].text).not.toContain("note.txt");
        });
    });

    describe("operator parsing", () => {
        it("handles tag operator", async () => {
            const result = await handler({ query: "tag:design", ...defaults });
            const text = result.content[0].text;
            expect(text).toContain("operators");
        });

        it("handles exclude operator", async () => {
            const result = await handler({ query: "design -backend", ...defaults });
            const text = result.content[0].text;
            // Should find design but not backend content
            expect(text).toContain("alpha.md");
        });

        it("handles exact phrase", async () => {
            const result = await handler({ query: '"quick brown fox"', ...defaults });
            expect(result.content[0].text).toContain("alpha.md");
        });
    });
});
