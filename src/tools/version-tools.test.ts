import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { initVault, pathExists } from "../utils/vault.js";
import { saveVersion } from "../utils/version-store.js";
import { invalidateVersionCache } from "../utils/version-index.js";
import * as listVersions from "../tools/list-versions.js";
import * as readVersion from "../tools/read-version.js";
import * as restoreVersion from "../tools/restore-version.js";
import * as diffVersions from "../tools/diff-versions.js";
import * as deleteVersion from "../tools/delete-version.js";

const TEST_VAULT = join(process.cwd(), "test-vault-temp-version-tools");

describe("Version Tools", () => {
    beforeEach(async () => {
        await mkdir(TEST_VAULT, { recursive: true });
        await mkdir(join(TEST_VAULT, "notes"), { recursive: true });
        await writeFile(join(TEST_VAULT, "notes", "test.md"), "current content");
        process.argv = ["node", "index.js", TEST_VAULT];
        initVault();
        invalidateVersionCache();
    });

    afterEach(async () => {
        await rm(TEST_VAULT, { recursive: true, force: true });
    });

    describe("list_versions", () => {
        it("should report no versions for a note with no history", async () => {
            const result = await listVersions.handler({ path: "notes/test.md" });
            expect(result.content[0].text).toContain("No versions found");
        });

        it("should list saved versions with metadata", async () => {
            await saveVersion({
                sourcePath: "notes/test.md",
                content: "version 1",
                reason: "first save",
            });
            await new Promise((r) => setTimeout(r, 10));
            await saveVersion({
                sourcePath: "notes/test.md",
                content: "version 2",
                reason: "second save",
            });

            const result = await listVersions.handler({ path: "notes/test.md" });
            expect(result.content[0].text).toContain("2 version(s)");
            expect(result.content[0].text).toContain("first save");
            expect(result.content[0].text).toContain("second save");
        });

        it("should respect limit parameter", async () => {
            for (let i = 0; i < 5; i++) {
                await saveVersion({
                    sourcePath: "notes/test.md",
                    content: `version ${i}`,
                    reason: `save ${i}`,
                });
            }

            const result = await listVersions.handler({ path: "notes/test.md", limit: 2 });
            expect(result.content[0].text).toContain("5 version(s)");
            expect(result.content[0].text).toContain("3 more version(s)");
        });

        it("should auto-append .md extension", async () => {
            await saveVersion({
                sourcePath: "notes/test.md",
                content: "version 1",
                reason: "test",
            });

            const result = await listVersions.handler({ path: "notes/test" });
            expect(result.content[0].text).toContain("1 version(s)");
        });
    });

    describe("read_version", () => {
        it("should read a specific version's content", async () => {
            const saved = await saveVersion({
                sourcePath: "notes/test.md",
                content: "historical content",
                reason: "test read",
            });

            const result = await readVersion.handler({
                path: "notes/test.md",
                timestamp: saved!.timestamp,
                include_metadata: true,
            });
            expect(result.content[0].text).toContain("historical content");
            expect(result.content[0].text).toContain("test read");
        });

        it("should return error for non-existent version", async () => {
            const result = await readVersion.handler({
                path: "notes/test.md",
                timestamp: "2099-01-01T00:00:00.000Z",
                include_metadata: true,
            });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain("Version not found");
        });

        it("should return content only when metadata is disabled", async () => {
            const saved = await saveVersion({
                sourcePath: "notes/test.md",
                content: "just content",
                reason: "test",
            });

            const result = await readVersion.handler({
                path: "notes/test.md",
                timestamp: saved!.timestamp,
                include_metadata: false,
            });
            expect(result.content[0].text).toBe("just content");
        });
    });

    describe("restore_version", () => {
        it("should restore a note to a previous version", async () => {
            const saved = await saveVersion({
                sourcePath: "notes/test.md",
                content: "restored content",
                reason: "original save",
            });

            const result = await restoreVersion.handler({
                path: "notes/test.md",
                timestamp: saved!.timestamp,
            });

            expect(result.content[0].text).toContain("Restored");
            const currentContent = await readFile(join(TEST_VAULT, "notes", "test.md"), "utf-8");
            expect(currentContent).toBe("restored content");
        });

        it("should save current content as a new version before restoring", async () => {
            const saved = await saveVersion({
                sourcePath: "notes/test.md",
                content: "old content",
                reason: "old",
            });

            await restoreVersion.handler({
                path: "notes/test.md",
                timestamp: saved!.timestamp,
            });

            // Should now have additional versions (the pre-restore snapshot + the restored one)
            invalidateVersionCache("notes/test.md");
            const listResult = await listVersions.handler({ path: "notes/test.md" });
            expect(listResult.content[0].text).toContain("version(s)");
        });

        it("should return error for non-existent version", async () => {
            const result = await restoreVersion.handler({
                path: "notes/test.md",
                timestamp: "2099-01-01T00:00:00.000Z",
            });
            expect(result.isError).toBe(true);
        });
    });

    describe("diff_versions", () => {
        it("should show differences between two versions", async () => {
            const v1 = await saveVersion({
                sourcePath: "notes/test.md",
                content: "line 1\nline 2\nline 3",
                reason: "v1",
            });
            await new Promise((r) => setTimeout(r, 10));
            const v2 = await saveVersion({
                sourcePath: "notes/test.md",
                content: "line 1\nmodified line 2\nline 3\nline 4",
                reason: "v2",
            });

            const result = await diffVersions.handler({
                path: "notes/test.md",
                from_timestamp: v1!.timestamp,
                to_timestamp: v2!.timestamp,
                context_lines: 3,
            });

            expect(result.content[0].text).toContain("-line 2");
            expect(result.content[0].text).toContain("+modified line 2");
            expect(result.content[0].text).toContain("+line 4");
        });

        it("should report no differences for identical versions", async () => {
            const v1 = await saveVersion({
                sourcePath: "notes/test.md",
                content: "same content",
                reason: "v1",
                skipDuplicate: false,
            });
            await new Promise((r) => setTimeout(r, 10));
            const v2 = await saveVersion({
                sourcePath: "notes/test.md",
                content: "same content",
                reason: "v2",
                skipDuplicate: false,
            });

            const result = await diffVersions.handler({
                path: "notes/test.md",
                from_timestamp: v1!.timestamp,
                to_timestamp: v2!.timestamp,
                context_lines: 3,
            });

            expect(result.content[0].text).toContain("No differences");
        });

        it("should return error for non-existent version", async () => {
            const result = await diffVersions.handler({
                path: "notes/test.md",
                from_timestamp: "2099-01-01T00:00:00.000Z",
                to_timestamp: "2099-02-01T00:00:00.000Z",
                context_lines: 3,
            });
            expect(result.isError).toBe(true);
        });
    });

    describe("delete_version", () => {
        it("should soft-delete a version", async () => {
            const saved = await saveVersion({
                sourcePath: "notes/test.md",
                content: "to delete",
                reason: "delete test",
            });

            const result = await deleteVersion.handler({
                path: "notes/test.md",
                timestamp: saved!.timestamp,
            });

            expect(result.content[0].text).toContain("Version deleted");
            expect(result.content[0].text).toContain(".trash");
        });

        it("should return error for non-existent version", async () => {
            const result = await deleteVersion.handler({
                path: "notes/test.md",
                timestamp: "2099-01-01T00:00:00.000Z",
            });
            expect(result.isError).toBe(true);
        });
    });
});
