import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { initVault } from "./vault.js";
import { searchIndex } from "./search-index.js";

const TEST_VAULT = join(process.cwd(), "test-vault-temp-search-index");

describe("SearchIndex precise invalidation", () => {
    beforeEach(async () => {
        await rm(TEST_VAULT, { recursive: true, force: true });
        await mkdir(TEST_VAULT, { recursive: true });
        await writeFile(join(TEST_VAULT, "alpha.md"), "alpha content with shareword", "utf-8");
        process.env.NOTES_VAULT_PATH = TEST_VAULT;
        delete process.argv[2];
        initVault();
        searchIndex.markDirty();
        await searchIndex.ensureSynchronized();
    });

    afterEach(async () => {
        delete process.env.NOTES_VAULT_PATH;
        await rm(TEST_VAULT, { recursive: true, force: true });
    });

    it("should index documents for lookup", () => {
        expect(searchIndex.getDocument("alpha.md")).toBeDefined();
    });

    it("should drop a deleted document and its postings on precise invalidation", async () => {
        await unlink(join(TEST_VAULT, "alpha.md"));
        searchIndex.invalidatePath("alpha.md");
        await searchIndex.ensureSynchronized();

        expect(searchIndex.getDocument("alpha.md")).toBeUndefined();
        // No orphan inverted entries left behind
        expect(searchIndex.getInvertedIndex().get("alpha")).toBeUndefined();
        expect(searchIndex.getInvertedIndex().get("shareword")).toBeUndefined();
    });

    it("should re-index an edited document on precise invalidation", async () => {
        await writeFile(join(TEST_VAULT, "alpha.md"), "brandnewtoken body", "utf-8");
        searchIndex.invalidatePath("alpha.md");
        await searchIndex.ensureSynchronized();

        const doc = searchIndex.getDocument("alpha.md");
        expect(doc?.termFreq.get("brandnewtoken")).toBe(1);
        expect(doc?.termFreq.get("shareword")).toBeUndefined();
        expect(searchIndex.getInvertedIndex().get("shareword")).toBeUndefined();
    });

    it("should resolve invalidated paths case-insensitively without duplicating keys", async () => {
        searchIndex.invalidatePath("ALPHA.MD");
        await searchIndex.ensureSynchronized();

        const paths = searchIndex.getDocuments().map((doc) => doc.path);
        expect(paths).toEqual(["alpha.md"]);
    });

    it("should treat unchanged paths as no-ops during precise invalidation", async () => {
        const before = searchIndex.getDocument("alpha.md")?.modified;
        searchIndex.invalidatePath("alpha.md");
        await searchIndex.ensureSynchronized();

        expect(searchIndex.getDocument("alpha.md")?.modified).toBe(before);
    });
});

describe("SearchIndex scoring, metadata and dirty rebuild", () => {
    beforeEach(async () => {
        await rm(TEST_VAULT, { recursive: true, force: true });
        await mkdir(join(TEST_VAULT, "notes"), { recursive: true });
        await writeFile(
            join(TEST_VAULT, "notes", "meeting-notes.md"),
            "---\ntitle: Meeting Notes\ntags: [#Product, Review]\n---\nMeeting agenda for the product sync.\nMeeting minutes will be recorded.\nMeeting adjourned.",
            "utf-8",
        );
        await writeFile(
            join(TEST_VAULT, "notes", "architecture.md"),
            "# Architecture\n\nSystem diagram and component overview with meeting cadence.",
            "utf-8",
        );
        process.env.NOTES_VAULT_PATH = TEST_VAULT;
        delete process.argv[2];
        initVault();
        searchIndex.markDirty();
        await searchIndex.ensureSynchronized();
    });

    afterEach(async () => {
        delete process.env.NOTES_VAULT_PATH;
        await rm(TEST_VAULT, { recursive: true, force: true });
    });

    it("should score absent query terms as zero in BM25", () => {
        const doc = searchIndex.getDocument("notes/meeting-notes.md");
        expect(doc).toBeDefined();
        expect(searchIndex.bm25Score(doc!, ["missingterm"])).toBe(0);
    });

    it("should rank documents with more term occurrences higher", () => {
        const frequent = searchIndex.getDocument("notes/meeting-notes.md");
        const sparse = searchIndex.getDocument("notes/architecture.md");
        expect(frequent).toBeDefined();
        expect(sparse).toBeDefined();
        expect(searchIndex.bm25Score(frequent!, ["meeting"])).toBeGreaterThan(
            searchIndex.bm25Score(sparse!, ["meeting"]),
        );
    });

    it("should extract normalised tags and title from frontmatter", () => {
        const doc = searchIndex.getDocument("notes/meeting-notes.md");
        expect(doc?.tags).toEqual(["product", "review"]);
        expect(doc?.title).toBe("Meeting Notes");
    });

    it("should suggest the closest indexed term for typo queries", () => {
        expect(searchIndex.suggestCorrection("meting")).toBe("meeting");
        expect(searchIndex.suggestCorrection("zzzzzzz")).toBeUndefined();
    });

    it("should rebuild from scratch after markDirty, pruning deletions", async () => {
        await unlink(join(TEST_VAULT, "notes", "architecture.md"));
        await writeFile(join(TEST_VAULT, "notes", "extra.md"), "freshtoken content", "utf-8");
        searchIndex.markDirty();
        await searchIndex.ensureSynchronized();

        expect(searchIndex.getDocument("notes/extra.md")?.termFreq.get("freshtoken")).toBe(1);
        expect(searchIndex.getDocument("notes/architecture.md")).toBeUndefined();
        expect(searchIndex.getInvertedIndex().get("architecture")).toBeUndefined();
    });

    it("should map every indexed token to its document paths", () => {
        expect(searchIndex.getInvertedIndex().get("meeting")).toEqual(
            new Set(["notes/meeting-notes.md", "notes/architecture.md"]),
        );
        expect(searchIndex.getAllTerms()).toContain("meeting");
    });
});
