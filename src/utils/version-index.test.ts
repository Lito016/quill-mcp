import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initVault } from "../utils/vault.js";
import { saveVersion } from "../utils/version-store.js";
import {
    getCachedVersions,
    invalidateVersionCache,
    getVersionCacheStats,
    getLatestVersion,
    hasVersions,
    findVersionByTimestamp,
} from "../utils/version-index.js";

const TEST_VAULT = join(process.cwd(), "test-vault-temp-version-index");

describe("Version Index", () => {
    beforeEach(async () => {
        await mkdir(TEST_VAULT, { recursive: true });
        await mkdir(join(TEST_VAULT, "notes"), { recursive: true });
        await writeFile(join(TEST_VAULT, "notes", "test.md"), "test content");
        process.argv = ["node", "index.js", TEST_VAULT];
        initVault();
        invalidateVersionCache(); // Clear all caches
    });

    afterEach(async () => {
        await rm(TEST_VAULT, { recursive: true, force: true });
    });

    describe("getCachedVersions", () => {
        it("should load versions from disk on first access", async () => {
            await saveVersion({
                sourcePath: "notes/test.md",
                content: "version 1",
                reason: "test",
            });

            const entries = await getCachedVersions("notes/test.md");
            expect(entries.length).toBe(1);
            expect(entries[0].reason).toBe("test");
        });

        it("should return cached versions on subsequent calls", async () => {
            await saveVersion({
                sourcePath: "notes/test.md",
                content: "version 1",
                reason: "test",
            });

            const entries1 = await getCachedVersions("notes/test.md");
            const entries2 = await getCachedVersions("notes/test.md");
            expect(entries1).toEqual(entries2);
        });

        it("should return empty array for notes with no versions", async () => {
            const entries = await getCachedVersions("notes/nonexistent.md");
            expect(entries).toEqual([]);
        });
    });

    describe("invalidateVersionCache", () => {
        it("should invalidate cache for a specific note", async () => {
            await saveVersion({
                sourcePath: "notes/test.md",
                content: "version 1",
                reason: "test",
            });

            // Load into cache
            await getCachedVersions("notes/test.md");
            expect(getVersionCacheStats().cachedNotes).toBe(1);

            // Invalidate
            invalidateVersionCache("notes/test.md");
            expect(getVersionCacheStats().cachedNotes).toBe(0);
        });

        it("should invalidate all caches when no path given", async () => {
            await saveVersion({
                sourcePath: "notes/test.md",
                content: "v1",
                reason: "test",
            });
            await saveVersion({
                sourcePath: "notes/other.md",
                content: "v2",
                reason: "test2",
            });

            await getCachedVersions("notes/test.md");
            await getCachedVersions("notes/other.md");
            expect(getVersionCacheStats().cachedNotes).toBe(2);

            invalidateVersionCache();
            expect(getVersionCacheStats().cachedNotes).toBe(0);
        });
    });

    describe("getLatestVersion", () => {
        it("should return the newest version", async () => {
            await saveVersion({
                sourcePath: "notes/test.md",
                content: "first",
                reason: "first",
            });
            await new Promise((r) => setTimeout(r, 10));
            await saveVersion({
                sourcePath: "notes/test.md",
                content: "second",
                reason: "second",
            });

            invalidateVersionCache("notes/test.md");
            const latest = await getLatestVersion("notes/test.md");
            expect(latest).not.toBeNull();
            expect(latest!.reason).toBe("second");
        });

        it("should return null when no versions exist", async () => {
            const latest = await getLatestVersion("notes/test.md");
            expect(latest).toBeNull();
        });
    });

    describe("hasVersions", () => {
        it("should return true when versions exist", async () => {
            await saveVersion({
                sourcePath: "notes/test.md",
                content: "content",
                reason: "test",
            });

            invalidateVersionCache("notes/test.md");
            expect(await hasVersions("notes/test.md")).toBe(true);
        });

        it("should return false when no versions exist", async () => {
            expect(await hasVersions("notes/test.md")).toBe(false);
        });
    });

    describe("findVersionByTimestamp", () => {
        it("should find a version by exact timestamp", async () => {
            const saved = await saveVersion({
                sourcePath: "notes/test.md",
                content: "findme",
                reason: "find test",
            });

            invalidateVersionCache("notes/test.md");
            const found = await findVersionByTimestamp("notes/test.md", saved!.timestamp);
            expect(found).not.toBeNull();
            expect(found!.content_hash).toBe(saved!.content_hash);
        });

        it("should find a version by prefix timestamp", async () => {
            const saved = await saveVersion({
                sourcePath: "notes/test.md",
                content: "findme",
                reason: "prefix test",
            });

            invalidateVersionCache("notes/test.md");
            const prefix = saved!.timestamp.slice(0, 13); // Just date + hour
            const found = await findVersionByTimestamp("notes/test.md", prefix);
            expect(found).not.toBeNull();
        });

        it("should return null when no match found", async () => {
            const found = await findVersionByTimestamp("notes/test.md", "2099-01-01T00:00:00.000Z");
            expect(found).toBeNull();
        });
    });

    describe("getVersionCacheStats", () => {
        it("should report correct stats", async () => {
            await saveVersion({
                sourcePath: "notes/test.md",
                content: "v1",
                reason: "test",
            });

            invalidateVersionCache();
            expect(getVersionCacheStats().cachedNotes).toBe(0);

            await getCachedVersions("notes/test.md");
            const stats = getVersionCacheStats();
            expect(stats.cachedNotes).toBe(1);
            expect(stats.totalEntries).toBe(1);
        });
    });
});
