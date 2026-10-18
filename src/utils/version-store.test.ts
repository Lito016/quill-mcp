import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { initVault, pathExists, getVaultRoot } from "../utils/vault.js";
import {
    contentHash,
    saveVersion,
    listVersions,
    readVersion,
    readVersionContent,
    pruneVersions,
    getVersionCount,
    deleteVersion,
    parseVersionFile,
    getVersionsPath,
} from "../utils/version-store.js";

const TEST_VAULT = join(process.cwd(), "test-vault-temp-versions");

describe("Version Store", () => {
    beforeEach(async () => {
        await mkdir(TEST_VAULT, { recursive: true });
        await mkdir(join(TEST_VAULT, "notes"), { recursive: true });
        await writeFile(join(TEST_VAULT, "notes", "test.md"), "original content");
        process.argv = ["node", "index.js", TEST_VAULT];
        initVault();
    });

    afterEach(async () => {
        await rm(TEST_VAULT, { recursive: true, force: true });
    });

    describe("contentHash", () => {
        it("should produce consistent hashes for the same content", () => {
            const hash1 = contentHash("hello world");
            const hash2 = contentHash("hello world");
            expect(hash1).toBe(hash2);
        });

        it("should produce different hashes for different content", () => {
            const hash1 = contentHash("hello world");
            const hash2 = contentHash("goodbye world");
            expect(hash1).not.toBe(hash2);
        });

        it("should return a 16-character hex string", () => {
            const hash = contentHash("test");
            expect(hash).toMatch(/^[a-f0-9]{16}$/);
        });
    });

    describe("parseVersionFile", () => {
        it("should parse a valid version file", () => {
            const raw = [
                "---",
                'timestamp: "2024-01-15T10:30:00.000Z"',
                'source_path: "notes/test.md"',
                'reason: "write_note overwrite"',
                'content_hash: "abc123def456789"',
                "size: 100",
                "---",
                "Hello world content",
            ].join("\n");

            const result = parseVersionFile(raw);
            expect(result).not.toBeNull();
            expect(result!.meta.timestamp).toBe("2024-01-15T10:30:00.000Z");
            expect(result!.meta.source_path).toBe("notes/test.md");
            expect(result!.meta.reason).toBe("write_note overwrite");
            expect(result!.meta.content_hash).toBe("abc123def456789");
            expect(result!.meta.size).toBe(100);
            expect(result!.content).toBe("Hello world content");
        });

        it("should return null for malformed content", () => {
            expect(parseVersionFile("not a version file")).toBeNull();
            expect(parseVersionFile("---\nno closing delimiter")).toBeNull();
            expect(parseVersionFile("")).toBeNull();
        });

        it("should handle escaped quotes in reason", () => {
            const raw = [
                "---",
                'timestamp: "2024-01-15T10:30:00.000Z"',
                'source_path: "notes/test.md"',
                'reason: "write_note \\"special\\" edit"',
                'content_hash: "abc123"',
                "size: 50",
                "---",
                "content",
            ].join("\n");

            const result = parseVersionFile(raw);
            expect(result).not.toBeNull();
            expect(result!.meta.reason).toBe('write_note "special" edit');
        });
    });

    describe("saveVersion", () => {
        it("should save a version file with correct frontmatter", async () => {
            const entry = await saveVersion({
                sourcePath: "notes/test.md",
                content: "original content",
                reason: "test save",
            });

            expect(entry).not.toBeNull();
            expect(entry!.source_path).toBe("notes/test.md");
            expect(entry!.reason).toBe("test save");
            expect(entry!.size).toBe(Buffer.byteLength("original content", "utf-8"));
            expect(entry!.content_hash).toBe(contentHash("original content"));
            expect(entry!.timestamp).toBeTruthy();

            // Verify file exists
            expect(await pathExists(entry!.file_path)).toBe(true);

            // Verify file content
            const raw = await readFile(entry!.file_path, "utf-8");
            expect(raw).toContain("timestamp:");
            expect(raw).toContain("source_path:");
            expect(raw).toContain("original content");
        });

        it("should skip duplicate versions when content is unchanged", async () => {
            const entry1 = await saveVersion({
                sourcePath: "notes/test.md",
                content: "same content",
                reason: "first save",
            });
            expect(entry1).not.toBeNull();

            const entry2 = await saveVersion({
                sourcePath: "notes/test.md",
                content: "same content",
                reason: "second save",
            });
            expect(entry2).toBeNull(); // Skipped due to duplicate
        });

        it("should save when skipDuplicate is false even with same content", async () => {
            const entry1 = await saveVersion({
                sourcePath: "notes/test.md",
                content: "same content",
                reason: "first save",
            });
            expect(entry1).not.toBeNull();

            const entry2 = await saveVersion({
                sourcePath: "notes/test.md",
                content: "same content",
                reason: "second save",
                skipDuplicate: false,
            });
            expect(entry2).not.toBeNull();
        });

        it("should create version directory structure", async () => {
            await saveVersion({
                sourcePath: "notes/deep/nested.md",
                content: "nested content",
                reason: "test",
            });

            const versionsDir = join(getVersionsPath(), "notes", "deep", "nested.md");
            expect(await pathExists(versionsDir)).toBe(true);
        });
    });

    describe("listVersions", () => {
        it("should return empty array when no versions exist", async () => {
            const versions = await listVersions("notes/test.md");
            expect(versions).toEqual([]);
        });

        it("should list versions sorted newest first", async () => {
            await saveVersion({
                sourcePath: "notes/test.md",
                content: "version 1",
                reason: "first",
            });

            // Small delay to ensure different timestamps
            await new Promise((r) => setTimeout(r, 10));

            await saveVersion({
                sourcePath: "notes/test.md",
                content: "version 2",
                reason: "second",
            });

            const versions = await listVersions("notes/test.md");
            expect(versions.length).toBe(2);
            // Newest first
            expect(versions[0].reason).toBe("second");
            expect(versions[1].reason).toBe("first");
        });
    });

    describe("readVersion", () => {
        it("should read a specific version by timestamp", async () => {
            const saved = await saveVersion({
                sourcePath: "notes/test.md",
                content: "version content here",
                reason: "test read",
            });

            const result = await readVersion("notes/test.md", saved!.timestamp);
            expect(result).not.toBeNull();
            expect(result!.content).toBe("version content here");
            expect(result!.meta.reason).toBe("test read");
        });

        it("should return null for non-existent version", async () => {
            const result = await readVersion("notes/test.md", "2099-01-01T00:00:00.000Z");
            expect(result).toBeNull();
        });

        it("should support partial timestamp matching", async () => {
            const saved = await saveVersion({
                sourcePath: "notes/test.md",
                content: "partial match content",
                reason: "partial",
            });

            // Use just the date portion
            const partial = saved!.timestamp.slice(0, 10);
            const result = await readVersion("notes/test.md", partial);
            expect(result).not.toBeNull();
            expect(result!.content).toBe("partial match content");
        });
    });

    describe("readVersionContent", () => {
        it("should return just the content string", async () => {
            const saved = await saveVersion({
                sourcePath: "notes/test.md",
                content: "just the content",
                reason: "content test",
            });

            const content = await readVersionContent("notes/test.md", saved!.timestamp);
            expect(content).toBe("just the content");
        });

        it("should return null for non-existent version", async () => {
            const content = await readVersionContent("notes/test.md", "2099-01-01T00:00:00.000Z");
            expect(content).toBeNull();
        });
    });

    describe("pruneVersions", () => {
        it("should remove old versions when over limit", async () => {
            // Save 5 versions with max 3
            for (let i = 0; i < 5; i++) {
                await saveVersion({
                    sourcePath: "notes/test.md",
                    content: `version ${i}`,
                    reason: `save ${i}`,
                    maxVersions: 3,
                });
            }

            const count = await getVersionCount("notes/test.md");
            expect(count).toBeLessThanOrEqual(3);
        });

        it("should not remove versions when under limit", async () => {
            for (let i = 0; i < 3; i++) {
                await saveVersion({
                    sourcePath: "notes/test.md",
                    content: `version ${i}`,
                    reason: `save ${i}`,
                    maxVersions: 10,
                });
            }

            const count = await getVersionCount("notes/test.md");
            expect(count).toBe(3);
        });
    });

    describe("getVersionCount", () => {
        it("should return 0 for notes with no versions", async () => {
            const count = await getVersionCount("notes/test.md");
            expect(count).toBe(0);
        });

        it("should return correct count after saves", async () => {
            await saveVersion({
                sourcePath: "notes/test.md",
                content: "v1",
                reason: "first",
            });
            await saveVersion({
                sourcePath: "notes/test.md",
                content: "v2",
                reason: "second",
            });

            const count = await getVersionCount("notes/test.md");
            expect(count).toBe(2);
        });
    });

    describe("deleteVersion", () => {
        it("should soft-delete a version to .trash", async () => {
            const saved = await saveVersion({
                sourcePath: "notes/test.md",
                content: "to be deleted",
                reason: "delete test",
            });

            const trashPath = await deleteVersion("notes/test.md", saved!.timestamp);
            expect(trashPath).not.toBeNull();
            expect(trashPath).toContain(".trash");

            // Version should no longer be listable
            const versions = await listVersions("notes/test.md");
            expect(versions.length).toBe(0);
        });

        it("should return null for non-existent version", async () => {
            const result = await deleteVersion("notes/test.md", "2099-01-01T00:00:00.000Z");
            expect(result).toBeNull();
        });
    });
});
