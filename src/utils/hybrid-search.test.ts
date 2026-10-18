/**
 * Tests for hybrid search utility and tool handlers.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initVault } from "../utils/vault.js";
import { normalizeScores, hybridSearch, hybridSearchSimilar } from "../utils/hybrid-search.js";
import { handler as hybridSearchHandler } from "../tools/hybrid-search.js";
import { handler as hybridSearchSimilarHandler } from "../tools/hybrid-search-similar.js";
import { searchIndex } from "../utils/search-index.js";
import { vectorStore } from "../utils/vector-store.js";

let testCounter = 0;
let TEST_VAULT = "";

// ─── Unit Tests: normalizeScores ─────────────────────────────────────

describe("normalizeScores", () => {
    it("returns empty array for empty input", () => {
        expect(normalizeScores([])).toEqual([]);
    });

    it("normalizes scores to [0, 1] range", () => {
        const result = normalizeScores([0, 5, 10]);
        expect(result).toEqual([0, 0.5, 1]);
    });

    it("handles all identical scores", () => {
        const result = normalizeScores([3, 3, 3]);
        // All identical nonzero scores get 1.0
        expect(result).toEqual([1, 1, 1]);
    });

    it("handles all zero scores", () => {
        const result = normalizeScores([0, 0, 0]);
        expect(result).toEqual([0, 0, 0]);
    });

    it("handles single element", () => {
        const result = normalizeScores([42]);
        expect(result).toEqual([1]);
    });

    it("clamps to [0, 1] for negative values", () => {
        const result = normalizeScores([-5, 0, 5]);
        expect(result[0]).toBe(0);
        expect(result[1]).toBe(0.5);
        expect(result[2]).toBe(1);
    });

    it("handles mixed positive and negative", () => {
        const result = normalizeScores([-10, 0, 10]);
        expect(result).toEqual([0, 0.5, 1]);
    });
});

// ─── Integration Tests ───────────────────────────────────────────────

describe("hybrid search integration", () => {
    beforeEach(async () => {
        TEST_VAULT = join(process.cwd(), `test-vault-hybrid-${process.pid}-${testCounter++}`);
        await rm(TEST_VAULT, { recursive: true, force: true });
        await mkdir(TEST_VAULT, { recursive: true });
        await mkdir(join(TEST_VAULT, "notes"), { recursive: true });
        await mkdir(join(TEST_VAULT, "projects"), { recursive: true });

        await writeFile(
            join(TEST_VAULT, "notes", "machine-learning.md"),
            "---\ntitle: Machine Learning\ntags:\n  - ai\n  - ml\n---\n\n# Machine Learning\n\nSupervised and unsupervised learning algorithms for data classification and prediction. Neural networks, decision trees, and support vector machines.",
        );
        await writeFile(
            join(TEST_VAULT, "notes", "deep-learning.md"),
            "---\ntitle: Deep Learning\ntags:\n  - ai\n  - deep-learning\n---\n\n# Deep Learning\n\nConvolutional and recurrent neural networks for image recognition and natural language processing. Backpropagation and gradient descent optimization.",
        );
        await writeFile(
            join(TEST_VAULT, "notes", "cooking.md"),
            "---\ntitle: Cooking Tips\ntags:\n  - cooking\n---\n\n# Cooking\n\nItalian pasta recipes, French sauces, and Japanese sushi techniques. Kitchen organization and meal preparation strategies.",
        );
        await writeFile(
            join(TEST_VAULT, "projects", "webapp.md"),
            "---\ntitle: Web App\ntags:\n  - project\n---\n\n# Web Application\n\nReact frontend with TypeScript and Tailwind CSS. Node.js backend with Express and PostgreSQL database.",
        );

        process.env.NOTES_VAULT_PATH = TEST_VAULT;
        initVault();
        vectorStore.reset();
    });

    afterEach(async () => {
        delete process.env.NOTES_VAULT_PATH;
        try {
            await rm(TEST_VAULT, { recursive: true, force: true });
        } catch {
            // Best effort
        }
    }, 10000);

    // ── hybridSearch utility ─────────────────────────────────────────

    describe("hybridSearch utility", () => {
        it("returns results for a valid query", async () => {
            const results = await hybridSearch({ query: "neural networks learning", top_k: 10, min_score: 0 });
            expect(results.length).toBeGreaterThan(0);
            // ML and DL notes should be top results
            const paths = results.map((r) => r.path);
            expect(paths.some((p) => p.includes("machine-learning"))).toBe(true);
            expect(paths.some((p) => p.includes("deep-learning"))).toBe(true);
        });

        it("returns empty for empty query", async () => {
            const results = await hybridSearch({ query: "", top_k: 10 });
            expect(results).toEqual([]);
        });

        it("returns empty for whitespace-only query", async () => {
            const results = await hybridSearch({ query: "   ", top_k: 10 });
            expect(results).toEqual([]);
        });

        it("respects top_k limit", async () => {
            const results = await hybridSearch({ query: "learning algorithms data", top_k: 2, min_score: 0 });
            expect(results.length).toBeLessThanOrEqual(2);
        });

        it("respects min_score threshold", async () => {
            const results = await hybridSearch({ query: "neural networks", top_k: 10, min_score: 0.99 });
            // Very high threshold should filter most/all results
            for (const r of results) {
                expect(r.score).toBeGreaterThanOrEqual(0.99);
            }
        });

        it("filters by project path", async () => {
            const results = await hybridSearch({
                query: "React TypeScript Express",
                top_k: 10,
                min_score: 0,
                project: "projects",
            });
            for (const r of results) {
                expect(r.path.startsWith("projects")).toBe(true);
            }
        });

        it("filters by tags", async () => {
            const results = await hybridSearch({
                query: "learning algorithms neural",
                top_k: 10,
                min_score: 0,
                tags: ["ai"],
            });
            for (const r of results) {
                expect(r.tags).toContain("ai");
            }
        });

        it("includes bm25_score and semantic_score in results", async () => {
            const results = await hybridSearch({ query: "machine learning", top_k: 5, min_score: 0 });
            if (results.length > 0) {
                const r = results[0];
                expect(r).toHaveProperty("bm25_score");
                expect(r).toHaveProperty("semantic_score");
                expect(r).toHaveProperty("score");
                expect(r).toHaveProperty("path");
                expect(r).toHaveProperty("preview");
                expect(r).toHaveProperty("tags");
                expect(r).toHaveProperty("modified");
            }
        });

        it("scores are in [0, 1] range", async () => {
            const results = await hybridSearch({ query: "learning", top_k: 10, min_score: 0 });
            for (const r of results) {
                expect(r.score).toBeGreaterThanOrEqual(0);
                expect(r.score).toBeLessThanOrEqual(1.05); // Allow small recency boost margin
                expect(r.bm25_score).toBeGreaterThanOrEqual(0);
                expect(r.bm25_score).toBeLessThanOrEqual(1);
                expect(r.semantic_score).toBeGreaterThanOrEqual(0);
                expect(r.semantic_score).toBeLessThanOrEqual(1);
            }
        });

        it("alpha=1 produces pure BM25 results", async () => {
            const results = await hybridSearch({ query: "neural networks", top_k: 5, min_score: 0, alpha: 1 });
            for (const r of results) {
                // With alpha=1, score should equal bm25_score
                expect(Math.abs(r.score - r.bm25_score)).toBeLessThan(0.01);
            }
        });

        it("alpha=0 produces pure semantic results", async () => {
            const results = await hybridSearch({ query: "neural networks", top_k: 5, min_score: 0, alpha: 0 });
            for (const r of results) {
                // With alpha=0, score should equal semantic_score
                expect(Math.abs(r.score - r.semantic_score)).toBeLessThan(0.01);
            }
        });

        it("boost_recent does not crash", async () => {
            const results = await hybridSearch({
                query: "machine learning",
                top_k: 5,
                min_score: 0,
                boost_recent: true,
            });
            // Just verify it doesn't throw
            expect(Array.isArray(results)).toBe(true);
        });

        it("deduplicates results by path", async () => {
            const results = await hybridSearch({ query: "learning", top_k: 10, min_score: 0 });
            const paths = results.map((r) => r.path);
            const uniquePaths = new Set(paths);
            expect(paths.length).toBe(uniquePaths.size);
        });

        it("results are sorted by score descending", async () => {
            const results = await hybridSearch({ query: "learning algorithms", top_k: 10, min_score: 0 });
            for (let i = 1; i < results.length; i++) {
                expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
            }
        });
    });

    // ── hybridSearchSimilar utility ──────────────────────────────────

    describe("hybridSearchSimilar utility", () => {
        it("finds similar notes for a reference note", async () => {
            // Force index build
            await searchIndex.ensureSynchronized();
            await vectorStore.rebuild();

            const results = await hybridSearchSimilar({
                path: "notes/machine-learning.md",
                top_k: 5,
                min_score: 0,
            });
            // Should find deep-learning as similar
            const paths = results.map((r) => r.path);
            expect(paths.some((p) => p.includes("deep-learning"))).toBe(true);
            // Should not include the reference note itself
            expect(paths.some((p) => p.includes("machine-learning"))).toBe(false);
        });

        it("respects top_k limit", async () => {
            await searchIndex.ensureSynchronized();
            await vectorStore.rebuild();

            const results = await hybridSearchSimilar({
                path: "notes/machine-learning.md",
                top_k: 1,
                min_score: 0,
            });
            expect(results.length).toBeLessThanOrEqual(1);
        });

        it("filters by project", async () => {
            await searchIndex.ensureSynchronized();
            await vectorStore.rebuild();

            const results = await hybridSearchSimilar({
                path: "notes/machine-learning.md",
                top_k: 10,
                min_score: 0,
                project: "projects",
            });
            for (const r of results) {
                expect(r.path.startsWith("projects")).toBe(true);
            }
        });

        it("filters by tags", async () => {
            await searchIndex.ensureSynchronized();
            await vectorStore.rebuild();

            const results = await hybridSearchSimilar({
                path: "notes/machine-learning.md",
                top_k: 10,
                min_score: 0,
                tags: ["ai"],
            });
            for (const r of results) {
                expect(r.tags).toContain("ai");
            }
        });
    });

    // ── Tool handler: hybrid_search ──────────────────────────────────

    describe("hybrid_search handler", () => {
        it("returns formatted results", async () => {
            const result = await hybridSearchHandler({
                query: "neural networks learning",
                top_k: 10,
                alpha: 0.5,
                min_score: 0,
                boost_recent: false,
            });
            const text = result.content[0].text;
            expect(text).toContain("hybrid");
            // Should contain percentage scores
            expect(text).toMatch(/\d+\.\d+%/);
        });

        it("returns no-results message for unmatched query", async () => {
            const result = await hybridSearchHandler({
                query: "xyznonexistent",
                top_k: 10,
                alpha: 0.5,
                min_score: 0.99,
                boost_recent: false,
            });
            const text = result.content[0].text;
            expect(text).toContain("No results");
        });

        it("includes BM25 and Semantic breakdown", async () => {
            const result = await hybridSearchHandler({
                query: "machine learning",
                top_k: 5,
                alpha: 0.5,
                min_score: 0,
                boost_recent: false,
            });
            const text = result.content[0].text;
            expect(text).toContain("BM25:");
            expect(text).toContain("Semantic:");
        });
    });

    // ── Tool handler: hybrid_search_similar ──────────────────────────

    describe("hybrid_search_similar handler", () => {
        it("returns error for missing file", async () => {
            const result = (await hybridSearchSimilarHandler({
                path: "nonexistent.md",
                top_k: 5,
                alpha: 0.5,
                min_score: 0,
            })) as { content: { type: string; text: string }[]; isError?: boolean };
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain("not found");
        });

        it("returns formatted similar results", async () => {
            await searchIndex.ensureSynchronized();
            await vectorStore.rebuild();

            const result = await hybridSearchSimilarHandler({
                path: "notes/machine-learning.md",
                top_k: 5,
                alpha: 0.5,
                min_score: 0,
            });
            const text = result.content[0].text;
            expect(text).toContain("hybrid");
            expect(text).toMatch(/\d+\.\d+%/);
        });

        it("returns no-results message when nothing matches", async () => {
            await searchIndex.ensureSynchronized();
            await vectorStore.rebuild();

            const result = await hybridSearchSimilarHandler({
                path: "notes/cooking.md",
                top_k: 5,
                alpha: 0.5,
                min_score: 0.99,
            });
            const text = result.content[0].text;
            expect(text).toContain("No similar notes");
        });
    });
});
