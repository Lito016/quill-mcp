/**
 * Tests for TF-IDF embedding computation and caching.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { initVault } from "./vault.js";
import {
    tokenize,
    hashContent,
    hashPath,
    chunkDocument,
    buildVocabulary,
    computeAllTfIdf,
    saveEmbedding,
    loadEmbedding,
    removeEmbeddings,
    listEmbeddingFiles,
    clearEmbeddingCache,
    chunkKey,
    isExcludedPath,
    estimateTokenCount,
} from "./embeddings.js";

let testCounter = 0;
let TEST_VAULT = "";

describe("embeddings", () => {
    beforeEach(async () => {
        TEST_VAULT = join(process.cwd(), `test-vault-embeddings-${process.pid}-${testCounter++}`);
        await rm(TEST_VAULT, { recursive: true, force: true });
        await mkdir(TEST_VAULT, { recursive: true });
        process.env.NOTES_VAULT_PATH = TEST_VAULT;
        initVault();
    });

    afterEach(async () => {
        delete process.env.NOTES_VAULT_PATH;
        try {
            await rm(TEST_VAULT, { recursive: true, force: true });
        } catch {
            // Best effort
        }
    }, 10000);

    describe("tokenize", () => {
        it("extracts lowercase terms", () => {
            const terms = tokenize("Hello World from TypeScript");
            expect(terms).toContain("hello");
            expect(terms).toContain("world");
            expect(terms).toContain("typescript");
        });

        it("filters stop words", () => {
            const terms = tokenize("the quick brown fox is a good animal");
            expect(terms).not.toContain("the");
            expect(terms).not.toContain("is");
            expect(terms).not.toContain("a");
            expect(terms).toContain("quick");
            expect(terms).toContain("brown");
            expect(terms).toContain("fox");
            expect(terms).toContain("good");
            expect(terms).toContain("animal");
        });

        it("filters short terms", () => {
            const terms = tokenize("I am a good developer");
            expect(terms).not.toContain("i");
            expect(terms).not.toContain("am");
            expect(terms).toContain("good");
            expect(terms).toContain("developer");
        });

        it("handles empty input", () => {
            expect(tokenize("")).toEqual([]);
            expect(tokenize("   ")).toEqual([]);
        });

        it("handles unicode characters", () => {
            const terms = tokenize("cafe resume naive");
            expect(terms.length).toBeGreaterThan(0);
        });
    });

    describe("hashContent", () => {
        it("produces consistent hashes", () => {
            const h1 = hashContent("hello world");
            const h2 = hashContent("hello world");
            expect(h1).toBe(h2);
        });

        it("produces different hashes for different content", () => {
            const h1 = hashContent("hello world");
            const h2 = hashContent("hello earth");
            expect(h1).not.toBe(h2);
        });

        it("returns a 16-char hex string", () => {
            const h = hashContent("test");
            expect(h).toMatch(/^[0-9a-f]{16}$/);
        });
    });

    describe("hashPath", () => {
        it("includes vault path in hash", () => {
            const h1 = hashPath("/vault/a", "notes/test.md");
            const h2 = hashPath("/vault/b", "notes/test.md");
            expect(h1).not.toBe(h2);
        });

        it("is consistent", () => {
            const h1 = hashPath("/vault", "notes/test.md");
            const h2 = hashPath("/vault", "notes/test.md");
            expect(h1).toBe(h2);
        });
    });

    describe("chunkDocument", () => {
        it("returns single chunk for short documents", () => {
            const chunks = chunkDocument("test.md", "Short note about testing.");
            expect(chunks).toHaveLength(1);
            expect(chunks[0].path).toBe("test.md");
            expect(chunks[0].chunkIndex).toBe(0);
            expect(chunks[0].totalChunks).toBe(1);
        });

        it("strips frontmatter before chunking", () => {
            const content = "---\ntitle: Test\ntags: [test]\n---\n\nBody content here.";
            const chunks = chunkDocument("test.md", content);
            expect(chunks[0].text).not.toContain("title:");
            expect(chunks[0].text).toContain("Body content");
        });

        it("splits long documents into multiple chunks", () => {
            // Generate content with >512 tokens
            const paragraphs: string[] = [];
            for (let i = 0; i < 30; i++) {
                paragraphs.push(`Paragraph ${i}: This is a test paragraph with enough words to contribute meaningful tokens to the document. We need many words here to exceed the chunk limit.`);
            }
            const content = paragraphs.join("\n\n");
            const chunks = chunkDocument("long.md", content);
            expect(chunks.length).toBeGreaterThan(1);
        });

        it("sets correct totalChunks on all chunks", () => {
            const paragraphs: string[] = [];
            for (let i = 0; i < 30; i++) {
                paragraphs.push(`Paragraph ${i}: Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`);
            }
            const content = paragraphs.join("\n\n");
            const chunks = chunkDocument("long.md", content);
            for (const chunk of chunks) {
                expect(chunk.totalChunks).toBe(chunks.length);
            }
        });

        it("handles empty content", () => {
            const chunks = chunkDocument("empty.md", "");
            expect(chunks).toHaveLength(1);
        });

        it("handles content with only frontmatter", () => {
            const chunks = chunkDocument("fm.md", "---\ntitle: Only Frontmatter\n---\n");
            expect(chunks).toHaveLength(1);
        });
    });

    describe("buildVocabulary", () => {
        it("builds vocabulary from chunks", () => {
            const chunks = [
                { path: "a.md", chunkIndex: 0, totalChunks: 1, text: "machine learning algorithms", contentHash: "h1" },
                { path: "b.md", chunkIndex: 0, totalChunks: 1, text: "deep learning networks", contentHash: "h2" },
            ];
            const vocab = buildVocabulary(chunks);
            expect(vocab).toContain("machine");
            expect(vocab).toContain("learning");
            expect(vocab).toContain("algorithms");
            expect(vocab).toContain("deep");
            expect(vocab).toContain("networks");
        });

        it("sorts vocabulary alphabetically", () => {
            const chunks = [
                { path: "a.md", chunkIndex: 0, totalChunks: 1, text: "zebra apple mango", contentHash: "h1" },
            ];
            const vocab = buildVocabulary(chunks);
            for (let i = 1; i < vocab.length; i++) {
                expect(vocab[i] >= vocab[i - 1]).toBe(true);
            }
        });

        it("handles empty input", () => {
            const vocab = buildVocabulary([]);
            expect(vocab).toEqual([]);
        });
    });

    describe("computeAllTfIdf", () => {
        it("produces vectors of vocabulary size", () => {
            const chunks = [
                { path: "a.md", chunkIndex: 0, totalChunks: 1, text: "machine learning algorithms", contentHash: "h1" },
                { path: "b.md", chunkIndex: 0, totalChunks: 1, text: "deep learning networks", contentHash: "h2" },
            ];
            const vocab = buildVocabulary(chunks);
            const vectors = computeAllTfIdf(chunks, vocab);
            expect(vectors.size).toBe(2);
            for (const vec of vectors.values()) {
                expect(vec).toHaveLength(vocab.length);
            }
        });

        it("produces L2-normalized vectors", () => {
            const chunks = [
                { path: "a.md", chunkIndex: 0, totalChunks: 1, text: "machine learning algorithms data", contentHash: "h1" },
                { path: "b.md", chunkIndex: 0, totalChunks: 1, text: "deep learning networks training", contentHash: "h2" },
            ];
            const vocab = buildVocabulary(chunks);
            const vectors = computeAllTfIdf(chunks, vocab);
            for (const vec of vectors.values()) {
                const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
                expect(magnitude).toBeCloseTo(1.0, 5);
            }
        });

        it("returns zero vector for empty text", () => {
            const chunks = [
                { path: "a.md", chunkIndex: 0, totalChunks: 1, text: "meaningful content here", contentHash: "h1" },
                { path: "b.md", chunkIndex: 0, totalChunks: 1, text: "", contentHash: "h2" },
            ];
            const vocab = buildVocabulary(chunks);
            const vectors = computeAllTfIdf(chunks, vocab);
            const emptyVec = vectors.get(chunkKey("b.md", 0));
            expect(emptyVec).toBeDefined();
            expect(emptyVec!.every((v) => v === 0)).toBe(true);
        });
    });

    describe("disk cache", () => {
        it("saves and loads embeddings", async () => {
            const data = {
                embedding: [0.1, 0.2, 0.3],
                timestamp: new Date().toISOString(),
                contentHash: "abc123",
                vocabulary: ["a", "b", "c"],
                chunkIndex: 0,
                totalChunks: 1,
            };
            await saveEmbedding("test.md", 0, data);
            const loaded = await loadEmbedding("test.md", 0, "abc123");
            expect(loaded).not.toBeNull();
            expect(loaded!.embedding).toEqual([0.1, 0.2, 0.3]);
            expect(loaded!.contentHash).toBe("abc123");
        });

        it("returns null for stale embeddings", async () => {
            const data = {
                embedding: [0.1, 0.2],
                timestamp: new Date().toISOString(),
                contentHash: "old_hash",
                vocabulary: ["a", "b"],
                chunkIndex: 0,
                totalChunks: 1,
            };
            await saveEmbedding("test.md", 0, data);
            const loaded = await loadEmbedding("test.md", 0, "new_hash");
            expect(loaded).toBeNull();
        });

        it("returns null for missing embeddings", async () => {
            const loaded = await loadEmbedding("nonexistent.md", 0, "hash");
            expect(loaded).toBeNull();
        });

        it("removes embeddings for a path", async () => {
            const data = {
                embedding: [0.1],
                timestamp: new Date().toISOString(),
                contentHash: "h",
                vocabulary: ["a"],
                chunkIndex: 0,
                totalChunks: 1,
            };
            await saveEmbedding("test.md", 0, data);
            await saveEmbedding("test.md", 1, { ...data, chunkIndex: 1, totalChunks: 2 });
            await removeEmbeddings("test.md");
            const files = await listEmbeddingFiles();
            const testFiles = files.filter((f) => f.includes(hashPath(TEST_VAULT, "test.md")));
            expect(testFiles).toHaveLength(0);
        });

        it("clears all cached embeddings", async () => {
            const data = {
                embedding: [0.1],
                timestamp: new Date().toISOString(),
                contentHash: "h",
                vocabulary: ["a"],
                chunkIndex: 0,
                totalChunks: 1,
            };
            await saveEmbedding("a.md", 0, data);
            await saveEmbedding("b.md", 0, data);
            const cleared = await clearEmbeddingCache();
            expect(cleared).toBeGreaterThanOrEqual(2);
            const files = await listEmbeddingFiles();
            expect(files).toHaveLength(0);
        });
    });

    describe("chunkKey", () => {
        it("creates unique keys", () => {
            expect(chunkKey("a.md", 0)).toBe("a.md::0");
            expect(chunkKey("a.md", 1)).toBe("a.md::1");
            expect(chunkKey("b.md", 0)).toBe("b.md::0");
        });
    });

    describe("isExcludedPath", () => {
        it("excludes .trash paths", () => {
            expect(isExcludedPath(".trash/deleted.md")).toBe(true);
        });

        it("excludes .versions paths", () => {
            expect(isExcludedPath("notes/.versions/old.md")).toBe(true);
        });

        it("excludes .embeddings paths", () => {
            expect(isExcludedPath(".embeddings/cache.json")).toBe(true);
        });

        it("allows normal paths", () => {
            expect(isExcludedPath("notes/test.md")).toBe(false);
            expect(isExcludedPath("projects/design/doc.md")).toBe(false);
        });
    });

    describe("estimateTokenCount", () => {
        it("counts whitespace-delimited words", () => {
            expect(estimateTokenCount("hello world")).toBe(2);
            expect(estimateTokenCount("one two three four")).toBe(4);
        });

        it("handles empty input", () => {
            expect(estimateTokenCount("")).toBe(0);
            expect(estimateTokenCount("   ")).toBe(0);
        });
    });
});
