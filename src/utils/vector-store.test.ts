/**
 * Tests for vector store and cosine similarity search.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initVault } from "./vault.js";
import { vectorStore, cosineSimilarity } from "./vector-store.js";

let testCounter = 0;
let TEST_VAULT = "";

describe("vector-store", () => {
    beforeEach(async () => {
        TEST_VAULT = join(process.cwd(), `test-vault-vector-${process.pid}-${testCounter++}`);
        await rm(TEST_VAULT, { recursive: true, force: true });
        await mkdir(TEST_VAULT, { recursive: true });
        await mkdir(join(TEST_VAULT, "notes"), { recursive: true });
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

    describe("cosineSimilarity", () => {
        it("returns 1 for identical vectors", () => {
            const v = [0.5, 0.5, 0.5];
            expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
        });

        it("returns 0 for orthogonal vectors", () => {
            expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
        });

        it("returns 0 for zero vectors", () => {
            expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
        });

        it("returns 0 for mismatched lengths", () => {
            expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
        });

        it("returns 0 for empty vectors", () => {
            expect(cosineSimilarity([], [])).toBe(0);
        });

        it("handles negative values", () => {
            const sim = cosineSimilarity([1, -1], [1, -1]);
            expect(sim).toBeCloseTo(1.0, 5);
        });

        it("returns negative for opposing vectors", () => {
            const sim = cosineSimilarity([1, 0], [-1, 0]);
            expect(sim).toBeCloseTo(-1.0, 5);
        });
    });

    describe("addDocument", () => {
        it("adds a document to the index", async () => {
            await vectorStore.addDocument("test.md", "Machine learning and artificial intelligence");
            expect(vectorStore.isIndexed("test.md")).toBe(true);
            expect(vectorStore.size()).toBeGreaterThan(0);
        });

        it("handles multiple documents", async () => {
            await vectorStore.addDocument("a.md", "Machine learning algorithms");
            await vectorStore.addDocument("b.md", "Deep learning neural networks");
            expect(vectorStore.isIndexed("a.md")).toBe(true);
            expect(vectorStore.isIndexed("b.md")).toBe(true);
        });

        it("handles empty content", async () => {
            await vectorStore.addDocument("empty.md", "");
            expect(vectorStore.isIndexed("empty.md")).toBe(true);
        });
    });

    describe("removeDocument", () => {
        it("removes a document from the index", async () => {
            await vectorStore.addDocument("test.md", "Some content here");
            expect(vectorStore.isIndexed("test.md")).toBe(true);
            await vectorStore.removeDocument("test.md");
            expect(vectorStore.isIndexed("test.md")).toBe(false);
        });

        it("handles removing non-existent document", async () => {
            await vectorStore.removeDocument("nonexistent.md");
            // Should not throw
        });
    });

    describe("search", () => {
        it("finds semantically similar documents", async () => {
            await vectorStore.addDocument("ml.md", "Machine learning algorithms and data science");
            await vectorStore.addDocument("cooking.md", "Italian pasta recipes and cooking techniques");
            await vectorStore.addDocument("ai.md", "Artificial intelligence and neural network training");

            const queryVector = vectorStore.computeQueryVector("machine learning");
            const results = vectorStore.search(queryVector, 5, 0);

            expect(results.length).toBeGreaterThan(0);
            // ML and AI docs should rank higher than cooking
            const paths = results.map((r) => r.path);
            expect(paths).toContain("ml.md");
        });

        it("respects top_k limit", async () => {
            for (let i = 0; i < 10; i++) {
                await vectorStore.addDocument(`doc${i}.md`, `Document ${i} about various topics`);
            }
            const queryVector = vectorStore.computeQueryVector("document");
            const results = vectorStore.search(queryVector, 3, 0);
            expect(results.length).toBeLessThanOrEqual(3);
        });

        it("respects min_similarity threshold", async () => {
            await vectorStore.addDocument("a.md", "Machine learning");
            await vectorStore.addDocument("b.md", "Cooking recipes");
            const queryVector = vectorStore.computeQueryVector("machine learning");
            const results = vectorStore.search(queryVector, 10, 0.9);
            // Only very similar results should pass
            for (const r of results) {
                expect(r.score).toBeGreaterThanOrEqual(0.9);
            }
        });

        it("returns empty for empty query", () => {
            // A query with only stop words produces a zero vector
            const queryVector = vectorStore.computeQueryVector("the a is");
            const results = vectorStore.search(queryVector, 10, 0.5);
            // Zero vector should produce 0 similarity
            expect(results).toEqual([]);
        });

        it("deduplicates by path", async () => {
            // Create a long document that will be chunked
            const paragraphs: string[] = [];
            for (let i = 0; i < 30; i++) {
                paragraphs.push(`Machine learning paragraph ${i} with algorithms and data science and training models.`);
            }
            await vectorStore.addDocument("long.md", paragraphs.join("\n\n"));

            const queryVector = vectorStore.computeQueryVector("machine learning");
            const results = vectorStore.search(queryVector, 10, 0);
            // Should only have one result per path
            const paths = results.map((r) => r.path);
            const unique = new Set(paths);
            expect(paths.length).toBe(unique.size);
        });
    });

    describe("findSimilar", () => {
        it("finds notes similar to a reference note", async () => {
            await vectorStore.addDocument("ref.md", "Machine learning and deep learning");
            await vectorStore.addDocument("similar.md", "Neural networks and AI training");
            await vectorStore.addDocument("different.md", "Italian cooking recipes");

            const results = vectorStore.findSimilar("ref.md", 5, 0);
            expect(results.length).toBeGreaterThan(0);
            // Should not include the reference itself
            for (const r of results) {
                expect(r.path).not.toBe("ref.md");
            }
        });

        it("returns empty for unindexed path", () => {
            const results = vectorStore.findSimilar("nonexistent.md", 5, 0);
            expect(results).toEqual([]);
        });
    });

    describe("rebuild", () => {
        it("indexes all vault files", async () => {
            await writeFile(
                join(TEST_VAULT, "notes", "alpha.md"),
                "---\ntitle: Alpha\n---\n\nMachine learning and data science.",
            );
            await writeFile(
                join(TEST_VAULT, "notes", "beta.md"),
                "---\ntitle: Beta\n---\n\nCooking recipes and kitchen tips.",
            );

            await vectorStore.rebuild();
            const status = vectorStore.getStatus();
            expect(status.isIndexed).toBe(true);
            expect(status.indexedChunks).toBeGreaterThanOrEqual(2);
            expect(status.vocabularySize).toBeGreaterThan(0);
        });

        it("handles empty vault", async () => {
            await vectorStore.rebuild();
            const status = vectorStore.getStatus();
            expect(status.isIndexed).toBe(false);
        });

        it("excludes protected directories", async () => {
            await mkdir(join(TEST_VAULT, ".trash"), { recursive: true });
            await writeFile(join(TEST_VAULT, ".trash", "deleted.md"), "trashed content");
            await writeFile(join(TEST_VAULT, "notes", "active.md"), "active content");

            await vectorStore.rebuild();
            expect(vectorStore.isIndexed(".trash/deleted.md")).toBe(false);
        });
    });

    describe("computeQueryVector", () => {
        it("produces a vector matching vocabulary size", async () => {
            await vectorStore.addDocument("test.md", "Machine learning algorithms");
            const queryVec = vectorStore.computeQueryVector("machine learning");
            const vocab = vectorStore.getVocabulary();
            expect(queryVec).toHaveLength(vocab.length);
        });

        it("produces L2-normalized vector", async () => {
            await vectorStore.addDocument("test.md", "Machine learning and data science");
            const queryVec = vectorStore.computeQueryVector("machine learning");
            const magnitude = Math.sqrt(queryVec.reduce((sum, v) => sum + v * v, 0));
            if (magnitude > 0) {
                expect(magnitude).toBeCloseTo(1.0, 5);
            }
        });
    });

    describe("getStatus", () => {
        it("reports correct status for empty index", () => {
            const status = vectorStore.getStatus();
            expect(status.isIndexed).toBe(false);
            expect(status.indexedChunks).toBe(0);
            expect(status.vocabularySize).toBe(0);
        });

        it("reports correct status after indexing", async () => {
            await vectorStore.addDocument("test.md", "Some content for testing");
            const status = vectorStore.getStatus();
            expect(status.isIndexed).toBe(true);
            expect(status.indexedChunks).toBeGreaterThan(0);
        });
    });

    describe("invalidate", () => {
        it("removes document from index", async () => {
            await vectorStore.addDocument("test.md", "Content to invalidate");
            expect(vectorStore.isIndexed("test.md")).toBe(true);
            await vectorStore.invalidate("test.md");
            expect(vectorStore.isIndexed("test.md")).toBe(false);
        });
    });
});
