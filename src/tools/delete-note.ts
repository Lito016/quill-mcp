import { unlink, readdir, lstat } from "node:fs/promises";
import { resolveVaultPath, pathExists, safeDeleteTarget } from "../utils/vault.js";
import { moveToTrash } from "../utils/trash.js";
import { join } from "node:path";
import * as z from "zod";
import { scheduleHiveRegen } from "./hive-auto-regen.js";
import { eventBus } from "../utils/event-bus.js";

export const name = "delete_note";
export const description =
    "Delete a note file from the vault. By default, moves to .trash/ (recoverable). Set permanent=true to delete immediately. " +
    "Supports glob patterns (e.g. 'drafts/*.md') and dry-run preview.";
export const inputSchema = z.object({
    path: z
        .string()
        .describe(
            "Path to the note file to delete, relative to the vault root. Supports glob patterns like 'folder/*.md'.",
        ),
    permanent: z
        .boolean()
        .default(false)
        .describe("If true, delete immediately without moving to trash (default: false)"),
    dry_run: z.boolean().default(false).describe("If true, show what would be deleted without actually deleting"),
});

export async function handler({ path, permanent, dry_run }: { path: string; permanent: boolean; dry_run: boolean }) {
    // Safety: block vault root and protected directory targets
    // For single file: use centralized safeDeleteTarget
    // For glob: validate pattern base first
    if (!path.includes("*")) {
        // Single file delete
        const fullPath = await safeDeleteTarget(path);

        if (!(await pathExists(fullPath))) {
            return { content: [{ type: "text" as const, text: `Error: Note not found at "${path}".` }], isError: true };
        }

        if (dry_run) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `[DRY RUN] Would ${permanent ? "permanently delete" : "move to trash"}: "${path}"`,
                    },
                ],
            };
        }

        if (permanent) {
            await unlink(fullPath);
            scheduleHiveRegen(path);
            eventBus.emitAsync({
                type: "note_deleted",
                path,
                timestamp: new Date().toISOString(),
                metadata: { permanent: true },
            });
            return { content: [{ type: "text" as const, text: `Note permanently deleted: "${path}".` }] };
        }

        await moveToTrash(fullPath);
        scheduleHiveRegen(path);
        eventBus.emitAsync({
            type: "note_deleted",
            path,
            timestamp: new Date().toISOString(),
            metadata: { permanent: false, trashed: true },
        });
        return {
            content: [
                {
                    type: "text" as const,
                    text: `Note moved to trash: "${path}". Recoverable via restore_note. Trash location: .trash/${path}`,
                },
            ],
        };
    }

    // Glob pattern delete
    const matchedFiles = await globMatch(path);

    if (matchedFiles.length === 0) {
        return { content: [{ type: "text" as const, text: `No files matched pattern "${path}".` }] };
    }

    if (dry_run) {
        const lines: string[] = [`[DRY RUN] Would delete ${matchedFiles.length} file(s) matching "${path}":`];
        for (const f of matchedFiles) {
            lines.push(`  ${permanent ? "✗" : "→ trash"} ${f}`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }

    const results: string[] = [];
    for (const file of matchedFiles) {
        const fullPath = await safeDeleteTarget(file);
        if (permanent) {
            await unlink(fullPath);
            results.push(`  ✓ Permanently deleted: ${file}`);
        } else {
            await moveToTrash(fullPath);
            results.push(`  ✓ Moved to trash: ${file}`);
        }
    }

    if (matchedFiles.length > 0) scheduleHiveRegen(matchedFiles[0]);
    const mode = permanent ? "permanently deleted" : "moved to trash";
    return {
        content: [{ type: "text" as const, text: `${matchedFiles.length} file(s) ${mode}:\n${results.join("\n")}` }],
    };
}

/**
 * Simple glob matching for vault paths.
 * Supports * (any chars in filename) and ** (any depth).
 */
async function globMatch(pattern: string): Promise<string[]> {
    const results: string[] = [];

    // Split pattern into directory and file parts
    const parts = pattern.split("/");
    const dirParts: string[] = [];
    let filePattern = "*";

    for (const part of parts) {
        if (part.includes("*") && part !== parts[parts.length - 1]) {
            // Directory-level glob
            dirParts.push(part);
        } else if (part.includes("*")) {
            filePattern = part;
        } else {
            dirParts.push(part);
        }
    }

    const baseDir = dirParts.join("/");
    const searchDir = resolveVaultPath(baseDir || ".");

    if (!(await pathExists(searchDir))) return [];

    // Convert glob pattern to regex
    const regexStr = filePattern
        .replace(/\./g, "\\.")
        .replace(/\*\*/g, "{{DOUBLESTAR}}")
        .replace(/\*/g, "[^/]*")
        .replace(/\{\{DOUBLESTAR\}\}/g, ".*");
    const regex = new RegExp(`^${regexStr}$`);

    async function scan(dir: string, prefix: string) {
        try {
            const entries = await readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.name === ".trash" || entry.name === ".quill-sessions" || entry.name === ".versions") continue;
                const entryPath = join(dir, entry.name);
                // Symlink defense: never recurse into symbolic links
                const entryStat = await lstat(entryPath);
                if (entryStat.isSymbolicLink()) continue;
                const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

                if (entry.isFile() && regex.test(entry.name)) {
                    results.push(relPath);
                } else if (entry.isDirectory()) {
                    await scan(entryPath, relPath);
                }
            }
        } catch {
            // Skip inaccessible directories
        }
    }

    await scan(searchDir, baseDir);
    return results;
}
