/**
 * Tests for semantic search, find-similar, index-vault, and embedding-status tools.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initVault } from "../utils/vault.js";
import { handler as semanticSearchHandler } from "./semantic-search.js";
import { handler as findSimilarHandler } from "./find-similar.js";
import { handler as indexVaultHandler } from "./index-vault.js";
import { handler as embeddingStatusHandler } from "./embedding-status.js";
import { vectorStore } from "../utils/vector-store.js";

let testCounter = 0;
let TEST_VAULT = "";

describe("semantic search tools", () => {
    beforeEach(async () => {
        TEST_VAULT = join(process.cwd(), `test-vault-semsearch-${process.pid}-${testCounter++}`);
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

    describe("semantic_search", () => {
        it("finds semantically related notes", async () => {
            const result = await semanticSearchHandler({
                query: "neural networks and training",
                top_k: 10,
                min_similarity: 0,
            });
            const text = result.content[0].text;
            expect(text).toContain("machine-learning.md");
            expect(text).toContain("deep-learning.md");
        });

        it("respects top_k parameter", async () => {
            const result = await semanticSearchHandler({
                query: "learning algorithms",
                top_k: 1,
                min_similarity: 0,
            });
            const text = result.content[0].text;
            // Should have at most 1 result
            const matches = text.match(/^\d+\./gm);
            expect(matches?.length ?? 0).toBeLessThanOrEqual(1);
        });

        it("filters by project path", async () => {
            const result = await semanticSearchHandler({
                query: "React TypeScript Express PostgreSQL",
                top_k: 10,
                min_similarity: 0,
                project: "projects",
            });
            const text = result.content[0].text;
            expect(text).toContain("webapp.md");
        });

        it("filters by tags", async () => {
            const result = await semanticSearchHandler({
                query: "learning algorithms data",
                top_k: 10,
                min_similarity: 0,
                tags: ["ai"],
            });
            const text = result.content[0].text;
            expect(text).toContain("machine-learning.md");
            expect(text).toContain("deep-learning.md");
            expect(text).not.toContain("cooking.md");
        });

        it("returns message for no results", async () => {
            const result = await semanticSearchHandler({
                query: "xyznonexistent",
                top_k: 10,
                min_similarity: 1.0,
            });
            const text = result.content[0].text;
            // Either no meaningful terms or no similar notes
            const hasNoResults = text.includes("No semantically similar") || text.includes("no meaningful terms");
            expect(hasNoResults).toBe(true);
        });

        it("includes similarity scores", async () => {
            const result = await semanticSearchHandler({
                query: "machine learning",
                top_k: 5,
                min_similarity: 0,
            });
            const text = result.content[0].text;
            // Should contain percentage scores
            expect(text).toMatch(/\d+\.\d+%/);
        });
    });

    describe("find_similar", () => {
        it("finds notes similar to a reference note", async () => {
            // First index the vault
            await vectorStore.rebuild();

            const result = await findSimilarHandler({
                path: "notes/machine-learning.md",
                top_k: 5,
                min_similarity: 0,
            });
            const text = result.content[0].text;
            expect(text).toContain("deep-learning.md");
            // The reference note should not appear as a numbered result
            const resultLines = text.split("\n").filter((l) => l.match(/^\d+\./));
            for (const line of resultLines) {
                expect(line).not.toContain("machine-learning.md");
            }
        });

        it("returns error for missing file", async () => {
            const result = await findSimilarHandler({
                path: "nonexistent.md",
                top_k: 5,
                min_similarity: 0,
            }) as { content: { type: "text"; text: string }[]; isError?: boolean };
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain("not found");
        });

        it("returns message when no similar notes found", async () => {
            await vectorStore.rebuild();
            const result = await findSimilarHandler({
                path: "notes/cooking.md",
                top_k: 5,
                min_similarity: 0.99,
            });
            const text = result.content[0].text;
            expect(text).toContain("No similar notes");
        });
    });

    describe("index_vault", () => {
        it("indexes all vault files", async () => {
            const result = await indexVaultHandler({ force: false });
            const text = result.content[0].text;
            expect(text).toContain("indexing complete");
            expect(text).toContain("Files scanned");
            expect(text).toContain("Chunks indexed");
        });

        it("reports vocabulary size", async () => {
            const result = await indexVaultHandler({ force: false });
            const text = result.content[0].text;
            expect(text).toContain("Vocabulary size");
        });

        it("supports force rebuild", async () => {
            const result = await indexVaultHandler({ force: true });
            const text = result.content[0].text;
            expect(text).toContain("indexing complete");
        });
    });

    describe("embedding_status", () => {
        it("reports status for unindexed vault", async () => {
            const result = await embeddingStatusHandler({});
            const text = result.content[0].text;
            expect(text).toContain("Semantic Search Index Status");
            expect(text).toContain("Vault markdown files");
        });

        it("reports status after indexing", async () => {
            await vectorStore.rebuild();
            const result = await embeddingStatusHandler({});
            const text = result.content[0].text;
            expect(text).toContain("Index built: Yes");
            expect(text).toContain("Vocabulary size");
        });
    });
});
