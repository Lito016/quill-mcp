import { getVaultRoot, pathExists, getPathStats } from "../utils/vault.js";
import { readdir, stat, lstat } from "node:fs/promises";
import { join, relative } from "node:path";
import * as z from "zod";

export const name = "vault_status";
export const description =
    "Check the vault status including statistics, storage info, recent activity, and health report.";
export const inputSchema = z.object({
    include_stats: z.boolean().default(true).describe("Include storage statistics (file count, sizes, largest files)"),
    include_recent: z.boolean().default(false).describe("Include last 10 recently modified files"),
    include_health: z.boolean().default(false).describe("Include health report (orphan notes, empty notes)"),
});

export async function handler({
    include_stats,
    include_recent,
    include_health,
}: {
    include_stats: boolean;
    include_recent: boolean;
    include_health: boolean;
}) {
    const vaultPath = getVaultRoot();
    const exists = await pathExists(vaultPath);

    if (!exists) {
        return {
            content: [
                {
                    type: "text" as const,
                    text: JSON.stringify(
                        { status: "error", message: "Vault path does not exist", path: vaultPath },
                        null,
                        2,
                    ),
                },
            ],
            isError: true,
        };
    }

    const stats = await getPathStats(vaultPath);

    if (!stats.isDirectory) {
        return {
            content: [
                {
                    type: "text" as const,
                    text: JSON.stringify(
                        { status: "error", message: "Vault path is not a directory", path: vaultPath },
                        null,
                        2,
                    ),
                },
            ],
            isError: true,
        };
    }

    const result: Record<string, unknown> = {
        status: "ok",
        path: vaultPath,
        accessible: true,
        isDirectory: true,
    };

    // Storage statistics
    if (include_stats) {
        const fileStats = await collectFileStats(vaultPath);
        result.total_files = fileStats.totalFiles;
        result.total_folders = fileStats.totalFolders;
        result.total_size_bytes = fileStats.totalSize;
        result.total_size_human = formatSize(fileStats.totalSize);
        result.average_file_size =
            fileStats.totalFiles > 0 ? formatSize(Math.round(fileStats.totalSize / fileStats.totalFiles)) : "0 B";
        result.largest_files = fileStats.largest.slice(0, 5).map((f) => ({
            path: f.relPath,
            size: formatSize(f.size),
        }));
        result.files_by_extension = fileStats.byExtension;
    }

    // Recent activity
    if (include_recent) {
        const recentFiles = await collectRecentFiles(vaultPath, 10);
        result.recent_files = recentFiles.map((f) => ({
            path: f.relPath,
            modified: f.modified,
            size: formatSize(f.size),
        }));
    }

    // Health report
    if (include_health) {
        const health = await collectHealthReport(vaultPath);
        result.health = {
            empty_notes: health.emptyNotes.length,
            empty_note_paths: health.emptyNotes.slice(0, 10),
            notes_without_frontmatter: health.noFrontmatter,
            trash_count: health.trashCount,
        };
    }

    return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
}

interface FileStatEntry {
    relPath: string;
    size: number;
    modified: string;
}

async function collectFileStats(dir: string): Promise<{
    totalFiles: number;
    totalFolders: number;
    totalSize: number;
    largest: FileStatEntry[];
    byExtension: Record<string, number>;
}> {
    let totalFiles = 0;
    let totalFolders = 0;
    let totalSize = 0;
    const allFiles: FileStatEntry[] = [];
    const byExtension: Record<string, number> = {};

    async function scan(d: string) {
        try {
            const entries = await readdir(d, { withFileTypes: true });
            for (const entry of entries) {
                if (
                    entry.name === ".trash" ||
                    entry.name === ".versions" ||
                    entry.name === ".quill-sessions" ||
                    entry.name === "node_modules" ||
                    entry.name === ".git"
                )
                    continue;
                const fullPath = join(d, entry.name);
                // Symlink defense: never recurse into symbolic links
                const entryStat = await lstat(fullPath);
                if (entryStat.isSymbolicLink()) continue;

                if (entry.isDirectory()) {
                    totalFolders++;
                    await scan(fullPath);
                } else if (entry.isFile()) {
                    totalFiles++;
                    try {
                        const s = await stat(fullPath);
                        totalSize += s.size;
                        const relPath = relative(getVaultRoot(), fullPath).replace(/\\/g, "/");
                        allFiles.push({ relPath, size: s.size, modified: s.mtime.toISOString() });

                        const ext = entry.name.includes(".") ? entry.name.split(".").pop()! : "none";
                        byExtension[ext] = (byExtension[ext] ?? 0) + 1;
                    } catch {
                        // Skip
                    }
                }
            }
        } catch {
            // Skip
        }
    }

    await scan(dir);
    allFiles.sort((a, b) => b.size - a.size);

    return { totalFiles, totalFolders, totalSize, largest: allFiles.slice(0, 10), byExtension };
}

async function collectRecentFiles(dir: string, limit: number): Promise<FileStatEntry[]> {
    const files: FileStatEntry[] = [];

    async function scan(d: string) {
        try {
            const entries = await readdir(d, { withFileTypes: true });
            for (const entry of entries) {
                if (
                    entry.name === ".trash" ||
                    entry.name === ".versions" ||
                    entry.name === ".quill-sessions" ||
                    entry.name === "node_modules" ||
                    entry.name === ".git"
                )
                    continue;
                const fullPath = join(d, entry.name);
                // Symlink defense: never recurse into symbolic links
                const entryStat = await lstat(fullPath);
                if (entryStat.isSymbolicLink()) continue;

                if (entry.isDirectory()) {
                    await scan(fullPath);
                } else if (entry.isFile()) {
                    try {
                        const s = await stat(fullPath);
                        const relPath = relative(getVaultRoot(), fullPath).replace(/\\/g, "/");
                        files.push({ relPath, size: s.size, modified: s.mtime.toISOString() });
                    } catch {
                        // Skip
                    }
                }
            }
        } catch {
            // Skip
        }
    }

    await scan(dir);
    files.sort((a, b) => b.modified.localeCompare(a.modified));
    return files.slice(0, limit);
}

async function collectHealthReport(dir: string): Promise<{
    emptyNotes: string[];
    noFrontmatter: number;
    trashCount: number;
}> {
    const emptyNotes: string[] = [];
    let noFrontmatter = 0;
    let trashCount = 0;

    async function scan(d: string) {
        try {
            const entries = await readdir(d, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.name === "node_modules" || entry.name === ".git") continue;
                const fullPath = join(d, entry.name);
                // Symlink defense: never recurse into symbolic links
                const entryStat = await lstat(fullPath);
                if (entryStat.isSymbolicLink()) continue;

                if (entry.name === ".trash" && entry.isDirectory()) {
                    trashCount = await countFiles(fullPath);
                    continue;
                }
                if (entry.name === ".quill-sessions" && entry.isDirectory()) continue;

                if (entry.isDirectory()) {
                    await scan(fullPath);
                } else if (entry.isFile() && entry.name.endsWith(".md")) {
                    try {
                        const { readFile } = await import("node:fs/promises");
                        const content = await readFile(fullPath, "utf-8");
                        const relPath = relative(getVaultRoot(), fullPath).replace(/\\/g, "/");

                        if (content.trim().length === 0) {
                            emptyNotes.push(relPath);
                        }
                        if (!content.startsWith("---")) {
                            noFrontmatter++;
                        }
                    } catch {
                        // Skip
                    }
                }
            }
        } catch {
            // Skip
        }
    }

    await scan(dir);
    return { emptyNotes, noFrontmatter, trashCount };
}

async function countFiles(dir: string): Promise<number> {
    let count = 0;
    try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            // Symlink defense: never recurse into symbolic links
            const entryStat = await lstat(fullPath);
            if (entryStat.isSymbolicLink()) continue;
            if (entry.isFile()) count++;
            if (entry.isDirectory()) count += await countFiles(fullPath);
        }
    } catch {
        // Skip
    }
    return count;
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
