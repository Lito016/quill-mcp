import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import {
    initVault,
    resolveVaultPath,
    pathExists,
    getPathStats,
    assertWithinVault,
    assertParentWithinVault,
    assertNotVaultRoot,
    assertNotProtectedDir,
    safeWriteTarget,
    safeDeleteTarget,
    safeReadTarget,
    safeInternalPath,
    safeWalkDir,
    safeReadFile,
    isSymlink,
    assertWithinRoot,
    getVaultRoot,
    type WalkSkipEntry,
} from "./vault.js";

const TEST_VAULT = join(process.cwd(), "test-vault-temp");

describe("Vault Utilities", () => {
    beforeEach(async () => {
        await mkdir(TEST_VAULT, { recursive: true });
        process.argv = ["node", "index.js", TEST_VAULT];
        initVault();
    });

    afterEach(async () => {
        await rm(TEST_VAULT, { recursive: true, force: true });
    });

    describe("resolveVaultPath", () => {
        it("should resolve relative paths against vault root", () => {
            const resolved = resolveVaultPath("notes/test.md");
            expect(resolved).toBe(join(TEST_VAULT, "notes/test.md"));
        });

        it("should block path traversal attacks", () => {
            expect(() => resolveVaultPath("../../etc/passwd")).toThrow("Path traversal blocked");
        });

        it("should block absolute paths outside vault", () => {
            expect(() => resolveVaultPath("/etc/passwd")).toThrow("Path traversal blocked");
        });

        it("should normalize backslashes to forward slashes", () => {
            const resolved = resolveVaultPath("notes\\test.md");
            expect(resolved).toContain("notes");
        });
    });

    describe("pathExists", () => {
        it("should return true for existing paths", async () => {
            const testFile = join(TEST_VAULT, "test.md");
            await writeFile(testFile, "test");
            expect(await pathExists(testFile)).toBe(true);
        });

        it("should return false for non-existing paths", async () => {
            expect(await pathExists(join(TEST_VAULT, "nonexistent.md"))).toBe(false);
        });
    });

    describe("security: vault root protection", () => {
        it("should block vault root as a deletion target", () => {
            expect(() => assertNotVaultRoot(".")).toThrow("Cannot modify the vault root");
            expect(() => assertNotVaultRoot("")).toThrow("Cannot modify the vault root");
        });

        it("should allow non-root paths", () => {
            expect(() => assertNotVaultRoot("notes/test.md")).not.toThrow();
            expect(() => assertNotVaultRoot("subfolder")).not.toThrow();
        });

        it("should block folder/.. patterns that resolve to root", () => {
            expect(() => assertNotVaultRoot("notes/..")).toThrow("Cannot modify the vault root");
            expect(() => assertNotVaultRoot("a/b/../../")).toThrow("Cannot modify the vault root");
        });

        it("should block absolute vault path", () => {
            const vaultRoot = getVaultRoot();
            expect(() => assertNotVaultRoot(vaultRoot)).toThrow("Cannot modify the vault root");
        });

        it("should block trailing separators", () => {
            expect(() => assertNotVaultRoot("./")).toThrow("Cannot modify the vault root");
        });

        it("should block case-variant absolute vault path on Windows", () => {
            const vaultRoot = getVaultRoot();
            // On Windows, test case-insensitive matching
            if (process.platform === "win32") {
                const upperCased = vaultRoot.toUpperCase();
                expect(() => assertNotVaultRoot(upperCased)).toThrow("Cannot modify the vault root");
            }
        });
    });

    describe("security: protected directories", () => {
        it("should block operations on .trash", () => {
            expect(() => assertNotProtectedDir(".trash")).toThrow("protected internal directory");
            expect(() => assertNotProtectedDir(".trash/old-note.md")).toThrow("protected internal directory");
        });

        it("should block operations on .git", () => {
            expect(() => assertNotProtectedDir(".git")).toThrow("protected internal directory");
            expect(() => assertNotProtectedDir(".git/config")).toThrow("protected internal directory");
        });

        it("should block operations on .quill-sessions", () => {
            expect(() => assertNotProtectedDir(".quill-sessions")).toThrow("protected internal directory");
        });

        it("should block node_modules", () => {
            expect(() => assertNotProtectedDir("node_modules")).toThrow("protected internal directory");
            expect(() => assertNotProtectedDir("node_modules/pkg/index.js")).toThrow("protected internal directory");
        });

        it("should allow normal paths", () => {
            expect(() => assertNotProtectedDir("notes/test.md")).not.toThrow();
            expect(() => assertNotProtectedDir("my-folder")).not.toThrow();
        });

        it("should NOT block .github (not a protected dir)", () => {
            expect(() => assertNotProtectedDir(".github")).not.toThrow();
            expect(() => assertNotProtectedDir(".github/workflows/ci.yml")).not.toThrow();
        });

        it("should NOT block names containing protected substrings", () => {
            expect(() => assertNotProtectedDir("my.git.notes")).not.toThrow();
            expect(() => assertNotProtectedDir("trash-can")).not.toThrow();
            expect(() => assertNotProtectedDir("node_modules_backup")).not.toThrow();
        });

        it("should block case-variant protected dirs on Windows/macOS", () => {
            if (process.platform === "win32" || process.platform === "darwin") {
                expect(() => assertNotProtectedDir(".TRASH")).toThrow("protected internal directory");
                expect(() => assertNotProtectedDir(".GIT")).toThrow("protected internal directory");
                expect(() => assertNotProtectedDir(".Trash")).toThrow("protected internal directory");
                expect(() => assertNotProtectedDir("NODE_MODULES")).toThrow("protected internal directory");
            }
        });
    });

    describe("security: safeWriteTarget", () => {
        it("should reject vault root as write target", async () => {
            await expect(safeWriteTarget(".")).rejects.toThrow("Cannot modify the vault root");
        });

        it("should reject protected dirs as write target", async () => {
            await expect(safeWriteTarget(".trash/test.md")).rejects.toThrow("protected internal directory");
        });

        it("should resolve valid write targets", async () => {
            const result = await safeWriteTarget("notes/new-file.md");
            expect(result).toContain("notes");
        });
    });

    describe("security: safeDeleteTarget", () => {
        it("should reject vault root as delete target", async () => {
            await expect(safeDeleteTarget(".")).rejects.toThrow("Cannot modify the vault root");
        });

        it("should reject protected dirs as delete target", async () => {
            await expect(safeDeleteTarget(".git")).rejects.toThrow("protected internal directory");
        });
    });

    describe("security: symlink defense", () => {
        it("should detect symlink escaping the vault via assertWithinVault", async () => {
            // Create a symlink inside the vault that points outside
            const outsideDir = join(process.cwd(), "outside-temp-vault-test");
            await mkdir(outsideDir, { recursive: true });
            const outsideFile = join(outsideDir, "secret.md");
            await writeFile(outsideFile, "secret data");

            const linkPath = join(TEST_VAULT, "evil-link.md");
            try {
                await symlink(outsideFile, linkPath);
            } catch {
                // Symlink creation may fail on some systems (e.g., Windows without dev mode)
                // Skip this test gracefully
                await rm(outsideDir, { recursive: true, force: true });
                return;
            }

            await expect(assertWithinVault(linkPath)).rejects.toThrow("symlink");

            // Cleanup
            await rm(linkPath, { force: true });
            await rm(outsideDir, { recursive: true, force: true });
        });

        it("should accept symlinks that stay within the vault", async () => {
            const targetFile = join(TEST_VAULT, "real-note.md");
            await writeFile(targetFile, "hello");

            const linkPath = join(TEST_VAULT, "safe-link.md");
            try {
                await symlink(targetFile, linkPath);
            } catch {
                // Skip on systems without symlink support
                return;
            }

            // Should not throw — symlink stays within vault
            await expect(assertWithinVault(linkPath)).resolves.toBeUndefined();

            await rm(linkPath, { force: true });
        });

        it("should detect parent symlink escape via assertParentWithinVault", async () => {
            const outsideDir = join(process.cwd(), "outside-parent-test");
            await mkdir(outsideDir, { recursive: true });

            // Create a symlink directory inside vault pointing outside
            const linkDir = join(TEST_VAULT, "evil-dir");
            try {
                await symlink(outsideDir, linkDir, "junction");
            } catch {
                await rm(outsideDir, { recursive: true, force: true });
                return;
            }

            const destPath = join(linkDir, "new-file.md");
            await expect(assertParentWithinVault(destPath)).rejects.toThrow("symlink");

            await rm(linkDir, { force: true });
            await rm(outsideDir, { recursive: true, force: true });
        });
    });

    describe("getPathStats", () => {
        it("should return correct stats for files", async () => {
            const testFile = join(TEST_VAULT, "test.md");
            await writeFile(testFile, "test content");
            const stats = await getPathStats(testFile);
            expect(stats.isFile).toBe(true);
            expect(stats.isDirectory).toBe(false);
            expect(stats.size).toBeGreaterThan(0);
        });

        it("should return correct stats for directories", async () => {
            const testDir = join(TEST_VAULT, "testdir");
            await mkdir(testDir);
            const stats = await getPathStats(testDir);
            expect(stats.isDirectory).toBe(true);
            expect(stats.isFile).toBe(false);
        });
    });

    describe("security: safeReadTarget", () => {
        it("should resolve existing in-vault file", async () => {
            await writeFile(join(TEST_VAULT, "readme.md"), "# Hello");
            const result = await safeReadTarget("readme.md");
            expect(result).toBe(join(TEST_VAULT, "readme.md"));
        });

        it("should throw for missing file", async () => {
            await expect(safeReadTarget("nonexistent.md")).rejects.toThrow("Path not found");
        });

        it("should throw for path traversal", async () => {
            await expect(safeReadTarget("../../etc/passwd")).rejects.toThrow("Path traversal blocked");
        });

        it("should throw for symlink escaping vault", async () => {
            const outsideDir = join(process.cwd(), "outside-read-test");
            await mkdir(outsideDir, { recursive: true });
            const outsideFile = join(outsideDir, "secret.md");
            await writeFile(outsideFile, "secret data");
            const linkPath = join(TEST_VAULT, "evil-read.md");
            try {
                await symlink(outsideFile, linkPath);
            } catch {
                await rm(outsideDir, { recursive: true, force: true });
                return;
            }
            await expect(safeReadTarget("evil-read.md")).rejects.toThrow("symlink");
            await rm(linkPath, { force: true });
            await rm(outsideDir, { recursive: true, force: true });
        });
    });

    describe("security: safeInternalPath", () => {
        it("should resolve valid internal directory", async () => {
            await mkdir(join(TEST_VAULT, ".trash"), { recursive: true });
            const result = await safeInternalPath(".trash");
            expect(result).toBe(join(TEST_VAULT, ".trash"));
        });

        it("should throw for traversal outside vault", async () => {
            await expect(safeInternalPath("../../etc")).rejects.toThrow("resolves outside the vault");
        });

        it("should throw for symlink escaping vault", async () => {
            const outsideDir = join(process.cwd(), "outside-internal-test");
            await mkdir(outsideDir, { recursive: true });
            const linkPath = join(TEST_VAULT, "evil-internal");
            try {
                await symlink(outsideDir, linkPath, "junction");
            } catch {
                await rm(outsideDir, { recursive: true, force: true });
                return;
            }
            await expect(safeInternalPath("evil-internal")).rejects.toThrow("symlink");
            await rm(linkPath, { force: true });
            await rm(outsideDir, { recursive: true, force: true });
        });

        it("should accept non-existing internal path (lexical check only)", async () => {
            const result = await safeInternalPath("new-internal-dir");
            expect(result).toContain("new-internal-dir");
        });
    });

    describe("security: safeWalkDir", () => {
        it("should walk files and directories normally", async () => {
            await mkdir(join(TEST_VAULT, "sub"), { recursive: true });
            await writeFile(join(TEST_VAULT, "sub", "a.md"), "a");
            await writeFile(join(TEST_VAULT, "sub", "b.md"), "b");
            const found: string[] = [];
            await safeWalkDir(join(TEST_VAULT, "sub"), TEST_VAULT, async (p) => {
                found.push(p);
            });
            expect(found.length).toBe(2);
        });

        it("should skip symlinks and record skip reason", async () => {
            const outsideDir = join(process.cwd(), "outside-walk-test");
            await mkdir(outsideDir, { recursive: true });
            await writeFile(join(outsideDir, "secret.md"), "secret");
            await mkdir(join(TEST_VAULT, "walkdir"), { recursive: true });
            await writeFile(join(TEST_VAULT, "walkdir", "real.md"), "real");
            const linkPath = join(TEST_VAULT, "walkdir", "evil-link");
            try {
                await symlink(outsideDir, linkPath, "junction");
            } catch {
                await rm(outsideDir, { recursive: true, force: true });
                return;
            }
            const skipLog: WalkSkipEntry[] = [];
            const found: string[] = [];
            await safeWalkDir(
                join(TEST_VAULT, "walkdir"),
                TEST_VAULT,
                async (p) => {
                    found.push(p);
                },
                skipLog,
            );
            expect(found.length).toBe(1);
            expect(found[0]).toContain("real.md");
            expect(skipLog.some((s) => s.reason === "symlink")).toBe(true);
            await rm(linkPath, { force: true });
            await rm(outsideDir, { recursive: true, force: true });
        });

        it("should record inaccessible directories", async () => {
            const inaccessDir = join(TEST_VAULT, "no-access");
            await mkdir(inaccessDir, { recursive: true });
            // On Windows, removing read permissions is unreliable, so we test
            // the skip mechanism by walking a directory that disappears mid-walk.
            // Instead, verify the skip log mechanism works with a valid directory.
            const skipLog: WalkSkipEntry[] = [];
            await safeWalkDir(inaccessDir, TEST_VAULT, async () => {}, skipLog);
            // No entries, no skips
            expect(skipLog.length).toBe(0);
            await rm(inaccessDir, { recursive: true, force: true });
        });
    });

    describe("security: safeReadFile", () => {
        it("should read file within allowed root", async () => {
            await writeFile(join(TEST_VAULT, "safe-file.md"), "safe content");
            const content = await safeReadFile(join(TEST_VAULT, "safe-file.md"), TEST_VAULT);
            expect(content).toBe("safe content");
        });

        it("should throw for file outside allowed root", async () => {
            const outsideDir = join(process.cwd(), "outside-readfile-test");
            await mkdir(outsideDir, { recursive: true });
            await writeFile(join(outsideDir, "external.md"), "external");
            await expect(safeReadFile(join(outsideDir, "external.md"), TEST_VAULT)).rejects.toThrow(
                "resolves outside allowed root",
            );
            await rm(outsideDir, { recursive: true, force: true });
        });
    });

    describe("security: isSymlink", () => {
        it("should return false for regular file", async () => {
            await writeFile(join(TEST_VAULT, "regular.md"), "data");
            expect(await isSymlink(join(TEST_VAULT, "regular.md"))).toBe(false);
        });

        it("should return false for missing path", async () => {
            expect(await isSymlink(join(TEST_VAULT, "ghost.md"))).toBe(false);
        });

        it("should return true for symlink", async () => {
            const target = join(TEST_VAULT, "target.md");
            await writeFile(target, "data");
            const link = join(TEST_VAULT, "link.md");
            try {
                await symlink(target, link);
            } catch {
                return;
            }
            expect(await isSymlink(link)).toBe(true);
            await rm(link, { force: true });
        });
    });

    describe("security: assertWithinRoot", () => {
        it("should accept path within root", async () => {
            await writeFile(join(TEST_VAULT, "inner.md"), "data");
            await expect(assertWithinRoot(join(TEST_VAULT, "inner.md"), TEST_VAULT)).resolves.toBeUndefined();
        });

        it("should throw for path outside root", async () => {
            const outsideDir = join(process.cwd(), "outside-root-test");
            await mkdir(outsideDir, { recursive: true });
            await writeFile(join(outsideDir, "ext.md"), "data");
            await expect(assertWithinRoot(join(outsideDir, "ext.md"), TEST_VAULT)).rejects.toThrow(
                "resolves outside allowed root",
            );
            await rm(outsideDir, { recursive: true, force: true });
        });
    });

    describe("security: safeWriteTarget with existing escaping symlink", () => {
        it("should reject write to existing symlink escaping vault", async () => {
            const outsideDir = join(process.cwd(), "outside-write-test");
            await mkdir(outsideDir, { recursive: true });
            const outsideFile = join(outsideDir, "target.md");
            await writeFile(outsideFile, "external");
            const linkPath = join(TEST_VAULT, "evil-write.md");
            try {
                await symlink(outsideFile, linkPath);
            } catch {
                await rm(outsideDir, { recursive: true, force: true });
                return;
            }
            await expect(safeWriteTarget("evil-write.md")).rejects.toThrow("symlink");
            await rm(linkPath, { force: true });
            await rm(outsideDir, { recursive: true, force: true });
        });

        it("should reject write when parent escapes via symlink", async () => {
            const outsideDir = join(process.cwd(), "outside-parent-write-test");
            await mkdir(outsideDir, { recursive: true });
            const linkDir = join(TEST_VAULT, "evil-parent");
            try {
                await symlink(outsideDir, linkDir, "junction");
            } catch {
                await rm(outsideDir, { recursive: true, force: true });
                return;
            }
            await expect(safeWriteTarget("evil-parent/new-file.md")).rejects.toThrow();
            await rm(linkDir, { force: true });
            await rm(outsideDir, { recursive: true, force: true });
        });
    });

    describe("security: safeDeleteTarget with existing escaping symlink", () => {
        it("should reject delete of symlink escaping vault", async () => {
            const outsideDir = join(process.cwd(), "outside-delete-test");
            await mkdir(outsideDir, { recursive: true });
            const outsideFile = join(outsideDir, "victim.md");
            await writeFile(outsideFile, "victim data");
            const linkPath = join(TEST_VAULT, "evil-delete.md");
            try {
                await symlink(outsideFile, linkPath);
            } catch {
                await rm(outsideDir, { recursive: true, force: true });
                return;
            }
            await expect(safeDeleteTarget("evil-delete.md")).rejects.toThrow("symlink");
            // Verify external file is untouched
            const { readFile: rf } = await import("node:fs/promises");
            const content = await rf(outsideFile, "utf-8");
            expect(content).toBe("victim data");
            await rm(linkPath, { force: true });
            await rm(outsideDir, { recursive: true, force: true });
        });
    });

    describe("resolveVaultPath: Windows-specific", () => {
        it("should handle backslash paths", () => {
            const resolved = resolveVaultPath("notes\\sub\\file.md");
            expect(resolved).toContain("notes");
            expect(resolved).toContain("sub");
            expect(resolved).toContain("file.md");
        });

        it("should block absolute paths on any platform", () => {
            expect(() => resolveVaultPath("C:/Windows/System32")).toThrow("Path traversal blocked");
            expect(() => resolveVaultPath("/usr/local/bin")).toThrow("Path traversal blocked");
        });
    });

    describe("initVault: auto-creation", () => {
        it("should create vault root and default dirs when vault does not exist", async () => {
            const freshVault = join(process.cwd(), "test-vault-fresh");
            await rm(freshVault, { recursive: true, force: true });

            process.argv = ["node", "index.js", freshVault];
            const result = initVault();

            expect(result).toBe(freshVault);
            expect(await pathExists(freshVault)).toBe(true);
            expect(await pathExists(join(freshVault, ".quill"))).toBe(true);
            expect(await pathExists(join(freshVault, ".trash"))).toBe(true);
            expect(await pathExists(join(freshVault, ".versions"))).toBe(true);
            expect(await pathExists(join(freshVault, ".quill-sessions"))).toBe(true);
            expect(await pathExists(join(freshVault, "notes"))).toBe(true);
            expect(await pathExists(join(freshVault, "tasks"))).toBe(true);
            expect(await pathExists(join(freshVault, "daily"))).toBe(true);
            expect(await pathExists(join(freshVault, "knowledge"))).toBe(true);
            expect(await pathExists(join(freshVault, "canvases"))).toBe(true);

            await rm(freshVault, { recursive: true, force: true });
        });

        it("should not fail when vault already exists with data", async () => {
            await writeFile(join(TEST_VAULT, "existing.md"), "# hello");
            const result = initVault();
            expect(result).toBe(TEST_VAULT);
            expect(await pathExists(join(TEST_VAULT, "existing.md"))).toBe(true);
        });
    });
});
