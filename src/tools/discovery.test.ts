import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initVault } from "../utils/vault.js";
import { knowledgeIndex } from "../utils/knowledge-index.js";
import { searchIndex } from "../utils/search-index.js";
import { handler as discover } from "./discover.js";
import { handler as searchFiles } from "./search-files.js";
import { handler as searchByTag } from "./search-by-tag.js";
import { handler as listFolder } from "./list-folder.js";
import { handler as searchNotes } from "./search-notes.js";
import { handler as searchByName } from "./search-by-name.js";

const TEST_VAULT = join(process.cwd(), "test-vault-temp-discovery");
const json = (result: Awaited<ReturnType<typeof discover>>) => JSON.parse(result.content[0].text);

async function seed(): Promise<void> {
    await mkdir(join(TEST_VAULT, "plugin", "prime-orchestrator", "nested"), { recursive: true });
    await mkdir(join(TEST_VAULT, "other"), { recursive: true });
    await writeFile(
        join(TEST_VAULT, "plugin", "prime-orchestrator", "prime-problem-PRD-MANAGEMENT.md"),
        `---
title: PRD Management Reference
tags:
  - PRD
  - template
  - prd
aliases:
  - product requirements document
---
# Requirements Workflow

Guidance for creating and maintaining specifications.`,
        "utf-8",
    );
    await writeFile(
        join(TEST_VAULT, "plugin", "prime-orchestrator", "nested", "deep.md"),
        "# Deep Heading\n\nDeep content",
        "utf-8",
    );
    await writeFile(
        join(TEST_VAULT, "other", "alias.md"),
        "---\ntitle: Something Else\naliases: [PRD]\ntags: [misc]\n---\nWeak body",
        "utf-8",
    );
    await writeFile(join(TEST_VAULT, "other", "content.md"), "This document says PRD in its body only.", "utf-8");
    await writeFile(
        join(TEST_VAULT, "other", "malformed.md"),
        "---\ntags: [broken\ntitle no colon\n---\nStill readable",
        "utf-8",
    );
    await writeFile(join(TEST_VAULT, "other", "plain.md"), "# Plain\nNo metadata", "utf-8");
    await writeFile(join(TEST_VAULT, "other", "special [draft].md"), "special", "utf-8");
    await writeFile(join(TEST_VAULT, "other", "special d.md"), "special", "utf-8");
}

describe("knowledge discovery", () => {
    beforeEach(async () => {
        await rm(TEST_VAULT, { recursive: true, force: true });
        await seed();
        process.env.NOTES_VAULT_PATH = TEST_VAULT;
        delete process.argv[2];
        initVault();
        knowledgeIndex.reset();
    });

    afterEach(async () => {
        knowledgeIndex.reset();
        delete process.env.NOTES_VAULT_PATH;
        await rm(TEST_VAULT, { recursive: true, force: true });
    });

    it("finds filename substrings case-insensitively and ranks them above content", async () => {
        const body = json(await discover({ query: "prd" }));
        const filenameResult = body.results.find((item: { path: string }) => item.path.includes("PRD-MANAGEMENT"));
        const contentResult = body.results.find((item: { path: string }) => item.path === "other/content.md");
        expect(filenameResult.matched_on).toContain("filename");
        expect(filenameResult.score).toBeGreaterThan(contentResult.score);
        expect(body.results.find((item: { path: string }) => item.path === "other/content.md")).toBeTruthy();
    });

    it("supports exact filename, title, alias, tag, path, and heading discovery", async () => {
        expect(json(await discover({ query: "plain.md" })).results[0].score).toBe(1);
        expect(json(await discover({ query: "PRD Management Reference" })).results[0].matched_on).toContain("title");
        expect(json(await discover({ query: "product requirements document" })).results[0].matched_on).toContain(
            "aliases",
        );
        expect(json(await discover({ query: "template" })).results[0].matched_on).toContain("tags");
        expect(
            json(await discover({ query: "prime-orchestrator", search_fields: ["path"] })).results.length,
        ).toBeGreaterThan(0);
        expect(json(await discover({ query: "Deep Heading", search_fields: ["headings"] })).results[0].path).toContain(
            "deep.md",
        );
    });

    it("supports tag AND/OR, normalization, and duplicate metadata tags", async () => {
        const and = JSON.parse((await searchByTag({ tags: ["#prd", "TEMPLATE"], operator: "AND" })).content[0].text);
        const or = JSON.parse((await searchByTag({ tags: ["missing", "prd"], operator: "OR" })).content[0].text);
        expect(and.total).toBe(1);
        expect(and.results[0].tags.map((tag: string) => tag.toLowerCase())).toEqual(["prd", "template"]);
        expect(or.total).toBe(1);
    });

    it("supports substring and safe glob filename/path searches", async () => {
        const substring = JSON.parse((await searchFiles({ pattern: "prd" })).content[0].text);
        const glob = JSON.parse(
            (await searchFiles({ pattern: "prime-*-PRD-??????????.md", match: "glob" })).content[0].text,
        );
        const chars = JSON.parse((await searchFiles({ pattern: "special [a-z].md", match: "glob" })).content[0].text);
        const special = JSON.parse((await searchFiles({ pattern: "[draft]", match: "substring" })).content[0].text);
        expect(substring.total).toBe(1);
        expect(glob.total).toBe(1);
        expect(chars.total).toBe(1);
        expect(special.total).toBe(1);
    });

    it("honors folder and recursive restrictions", async () => {
        const shallow = JSON.parse(
            (await searchFiles({ pattern: ".md", folder: "plugin/prime-orchestrator", recursive: false })).content[0]
                .text,
        );
        const deep = JSON.parse(
            (await searchFiles({ pattern: ".md", folder: "plugin/prime-orchestrator", recursive: true })).content[0]
                .text,
        );
        expect(shallow.total).toBe(1);
        expect(deep.total).toBe(2);
    });

    it("lists folders recursively and non-recursively with metadata", async () => {
        const shallow = JSON.parse(
            (await listFolder({ folder: "plugin/prime-orchestrator", recursive: false })).content[0].text,
        );
        const deep = JSON.parse(
            (await listFolder({ folder: "plugin/prime-orchestrator", recursive: true })).content[0].text,
        );
        expect(shallow.entries.some((entry: { path: string }) => entry.path.endsWith("nested/deep.md"))).toBe(false);
        expect(deep.entries.some((entry: { path: string }) => entry.path.endsWith("nested/deep.md"))).toBe(true);
        expect(shallow.entries.find((entry: { type: string }) => entry.type === "file").title).toBe(
            "PRD Management Reference",
        );
    });

    it("bounds and paginates deterministic results", async () => {
        const first = json(await discover({ query: ".md", search_fields: ["filename"], limit: 2 }));
        const second = json(
            await discover({ query: ".md", search_fields: ["filename"], limit: 2, cursor: first.next_cursor }),
        );
        expect(first.count).toBe(2);
        expect(first.next_cursor).toBeTruthy();
        expect(new Set([...first.results, ...second.results].map((entry) => entry.path)).size).toBe(4);
    });

    it("rejects traversal and malformed globs", async () => {
        await expect(discover({ query: "x", folder: "../../outside" })).rejects.toThrow("Path traversal blocked");
        await expect(searchFiles({ pattern: "[broken", match: "glob" })).rejects.toThrow("unclosed character class");
    });

    it("tolerates malformed and missing frontmatter", async () => {
        const malformed = json(await discover({ query: "malformed" }));
        const plain = json(await discover({ query: "plain" }));
        expect(malformed.results[0].path).toContain("malformed.md");
        expect(plain.results[0].path).toContain("plain.md");
    });

    it("removes renamed, moved, and deleted paths and refreshes changed metadata", async () => {
        await discover({ query: "PRD" });
        const source = join(TEST_VAULT, "plugin", "prime-orchestrator", "prime-problem-PRD-MANAGEMENT.md");
        const moved = join(TEST_VAULT, "other", "renamed.md");
        await rename(source, moved);
        await knowledgeIndex.synchronize();
        let result = json(await discover({ query: "prime-problem" }));
        expect(result.total).toBe(0);
        result = json(await discover({ query: "renamed" }));
        expect(result.results[0].path).toBe("other/renamed.md");
        await writeFile(moved, "---\ntitle: Updated Metadata\ntags: [changed]\n---\nbody with padding", "utf-8");
        await knowledgeIndex.synchronize();
        result = json(await discover({ query: "Updated Metadata" }));
        expect(result.results[0].matched_on).toContain("title");
        await unlink(moved);
        await knowledgeIndex.synchronize();
        result = json(await discover({ query: "Updated Metadata" }));
        expect(result.total).toBe(0);
    });

    it("keeps search_notes behavior compatible", async () => {
        const result = await searchNotes({
            query: "Deep content",
            path: ".",
            fileExtension: ".md",
            useRegex: false,
            fuzzy: false,
            highlight: false,
            sort: "relevance",
            snippets: 0,
            frontmatter_only: false,
            deduplicate: false,
            wildcard: false,
            limit: 10,
            offset: 0,
            showTokenEstimate: false,
        });
        expect(result.content[0].text).toContain("deep.md");
    });

    it("offers did-you-mean suggestions on zero-result typo queries", async () => {
        const body = json(await discover({ query: "prr" }));
        expect(body.results).toHaveLength(0);
        expect(body.suggestion).toBe("prd");
    });

    it("restricts search_notes to the requested folder without prefix collisions", async () => {
        await mkdir(join(TEST_VAULT, "Projects"), { recursive: true });
        await mkdir(join(TEST_VAULT, "ProjectsX"), { recursive: true });
        await writeFile(join(TEST_VAULT, "Projects", "a.md"), "needlebound here", "utf-8");
        await writeFile(join(TEST_VAULT, "ProjectsX", "b.md"), "needlebound here", "utf-8");
        // Queue the new files through the precise invalidation path
        searchIndex.invalidatePath("Projects/a.md");
        searchIndex.invalidatePath("ProjectsX/b.md");
        await searchIndex.ensureSynchronized();
        const result = await searchNotes({
            query: "needlebound",
            path: "Projects",
            fileExtension: ".md",
            useRegex: false,
            fuzzy: false,
            highlight: false,
            sort: "relevance",
            snippets: 0,
            frontmatter_only: false,
            deduplicate: false,
            wildcard: false,
            offset: 0,
            showTokenEstimate: false,
        });
        const text = result.content[0].text;
        expect(text).toContain("Projects/a.md");
        expect(text).not.toContain("ProjectsX/b.md");
    });

    it("never matches filenames inside internal directories", async () => {
        await mkdir(join(TEST_VAULT, "node_modules", "fake-pkg"), { recursive: true });
        await writeFile(join(TEST_VAULT, "node_modules", "fake-pkg", "target-name.md"), "dep", "utf-8");
        await writeFile(join(TEST_VAULT, "other", "target-name.md"), "real note", "utf-8");
        const result = await searchByName({ pattern: "target-name", path: ".", recursive: true });
        const text = result.content[0].text;
        expect(text).toContain("other/target-name.md");
        expect(text).not.toContain("node_modules");
    });
});
