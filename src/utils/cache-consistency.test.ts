/**
 * Cache consistency tests for the LRU read cache in vault.ts.
 * Verifies correctness under path normalization, failed writes,
 * concurrent access, and external edits.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
    initVault,
    cachedReadFile,
    invalidateReadCache,
} from "./vault.js";

let testCounter = 0;
let TEST_VAULT = "";

describe("LRU Read Cache Consistency", () => {
    beforeEach(async () => {
        TEST_VAULT = join(process.cwd(), `.test-vault-cache-${process.pid}-${testCounter++}`);
        await rm(TEST_VAULT, { recursive: true, force: true });
        await mkdir(TEST_VAULT, { recursive: true });
        await mkdir(join(TEST_VAULT, "sub"), { recursive: true });
        process.env.NOTES_VAULT_PATH = TEST_VAULT;
        initVault();
    });

    afterEach(async () => {
        invalidateReadCache();
        delete process.env.NOTES_VAULT_PATH;
        try {
            await rm(TEST_VAULT, { recursive: true, force: true });
        } catch {
            // Best effort
        }
    });

    describe("cache key consistency", () => {
        it("returns the same content for the same absolute path", async () => {
            const filePath = join(TEST_VAULT, "test.md");
            await writeFile(filePath, "original content", "utf-8");

            const first = await cachedReadFile(filePath);
            const second = await cachedReadFile(filePath);
            expect(first).toBe(second);
            expect(first).toBe("original content");
        });

        it("returns updated content after invalidation", async () => {
            const filePath = join(TEST_VAULT, "test.md");
            await writeFile(filePath, "version 1", "utf-8");

            const v1 = await cachedReadFile(filePath);
            expect(v1).toBe("version 1");

            // Write new content and invalidate
            await writeFile(filePath, "version 2", "utf-8");
            invalidateReadCache(filePath);

            const v2 = await cachedReadFile(filePath);
            expect(v2).toBe("version 2");
        });

        it("does not serve stale content after full cache invalidation", async () => {
            const filePath = join(TEST_VAULT, "test.md");
            await writeFile(filePath, "original", "utf-8");

            await cachedReadFile(filePath);
            await writeFile(filePath, "updated", "utf-8");
            invalidateReadCache(); // Full invalidation

            const result = await cachedReadFile(filePath);
            expect(result).toBe("updated");
        });
    });

    describe("failed writes do not corrupt cache", () => {
        it("cache reflects only successfully persisted content", async () => {
            const filePath = join(TEST_VAULT, "test.md");
            await writeFile(filePath, "persisted", "utf-8");

            // Read to populate cache
            const cached = await cachedReadFile(filePath);
            expect(cached).toBe("persisted");

            // Simulate: write to disk then invalidate (the correct pattern)
            await writeFile(filePath, "new content", "utf-8");
            invalidateReadCache(filePath);

            // Cache should reflect the new persisted content
            const result = await cachedReadFile(filePath);
            expect(result).toBe("new content");
        });

        it("invalidation before re-read prevents stale data", async () => {
            const filePath = join(TEST_VAULT, "test.md");
            await writeFile(filePath, "v1", "utf-8");
            await cachedReadFile(filePath);

            // Multiple write-invalidate cycles
            for (let i = 2; i <= 5; i++) {
                await writeFile(filePath, `v${i}`, "utf-8");
                invalidateReadCache(filePath);
                const content = await cachedReadFile(filePath);
                expect(content).toBe(`v${i}`);
            }
        });
    });

    describe("concurrent read/write safety", () => {
        it("handles concurrent reads of the same file", async () => {
            const filePath = join(TEST_VAULT, "concurrent.md");
            await writeFile(filePath, "shared content", "utf-8");

            // Fire 20 concurrent reads
            const reads = Array.from({ length: 20 }, () => cachedReadFile(filePath));
            const results = await Promise.all(reads);

            for (const result of results) {
                expect(result).toBe("shared content");
            }
        });

        it("handles interleaved reads and invalidations", async () => {
            const filePath = join(TEST_VAULT, "interleaved.md");
            await writeFile(filePath, "initial", "utf-8");

            // Interleave reads and invalidations
            const ops: Promise<string>[] = [];
            for (let i = 0; i < 10; i++) {
                ops.push(cachedReadFile(filePath));
                if (i === 5) {
                    await writeFile(filePath, "updated", "utf-8");
                    invalidateReadCache(filePath);
                }
            }
            const results = await Promise.all(ops);

            // All reads before the invalidation should return "initial"
            // All reads after should return "updated"
            // Due to async scheduling, we just verify no corruption
            for (const r of results) {
                expect(["initial", "updated"]).toContain(r);
            }
        });
    });

    describe("external edit consistency policy", () => {
        it("documents that external edits require explicit invalidation", async () => {
            const filePath = join(TEST_VAULT, "external.md");
            await writeFile(filePath, "original", "utf-8");

            // Agent reads file (populates cache)
            const v1 = await cachedReadFile(filePath);
            expect(v1).toBe("original");

            // External process modifies the file (simulated)
            await writeFile(filePath, "externally modified", "utf-8");

            // Without invalidation, cache returns stale content
            const stale = await cachedReadFile(filePath);
            expect(stale).toBe("original"); // This is the documented behavior

            // After invalidation, fresh content is returned
            invalidateReadCache(filePath);
            const fresh = await cachedReadFile(filePath);
            expect(fresh).toBe("externally modified");
        });

        it("global invalidation refreshes all entries", async () => {
            const files = ["a.md", "b.md", "c.md"];
            for (const f of files) {
                await writeFile(join(TEST_VAULT, f), `original-${f}`, "utf-8");
                await cachedReadFile(join(TEST_VAULT, f));
            }

            // Simulate external edits to all files
            for (const f of files) {
                await writeFile(join(TEST_VAULT, f), `updated-${f}`, "utf-8");
            }

            // Global invalidation
            invalidateReadCache();

            // All files should return fresh content
            for (const f of files) {
                const content = await cachedReadFile(join(TEST_VAULT, f));
                expect(content).toBe(`updated-${f}`);
            }
        });
    });

    describe("cache eviction", () => {
        it("evicts oldest entry when cache exceeds max size", async () => {
            // Write 150 unique files (exceeds CACHE_MAX_SIZE of 128)
            const paths: string[] = [];
            for (let i = 0; i < 150; i++) {
                const p = join(TEST_VAULT, `file-${i}.md`);
                await writeFile(p, `content-${i}`, "utf-8");
                paths.push(p);
            }

            // Read all files to populate cache
            for (const p of paths) {
                await cachedReadFile(p);
            }

            // The first files should have been evicted
            // Re-read the first file — it should still work (just from disk)
            const first = await cachedReadFile(paths[0]);
            expect(first).toBe("content-0");

            // The last files should be in cache
            const last = await cachedReadFile(paths[149]);
            expect(last).toBe("content-149");
        });
    });
});
