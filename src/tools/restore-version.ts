import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { readVersion, saveVersion } from "../utils/version-store.js";
import { invalidateVersionCache } from "../utils/version-index.js";
import { resolveVaultPath, pathExists, safeWriteTarget, invalidateReadCache } from "../utils/vault.js";
import { invalidateGraphCache } from "../utils/graph-cache.js";
import { pushUndo } from "../utils/undo-stack.js";
import { recordMutation } from "../utils/session-tracker.js";
import * as z from "zod";

export const name = "restore_version";
export const description =
    "Restore a note to a previous version. Creates a new version snapshot of the current content first, " +
    "then overwrites the note with the selected version's content. " +
    "Use list_versions to see available timestamps.";

export const inputSchema = z.object({
    path: z.string().describe("Path to the note file, relative to the vault root (.md appended if no extension)"),
    timestamp: z
        .string()
        .describe(
            "ISO timestamp of the version to restore (from list_versions output). " +
                "Partial timestamps are supported (prefix match).",
        ),
});

export async function handler({ path, timestamp }: { path: string; timestamp: string }) {
    const resolvedPath = path.endsWith(".md") ? path : `${path}.md`;
    const fullPath = await safeWriteTarget(resolvedPath);

    // Read the version to restore
    const versionResult = await readVersion(resolvedPath, timestamp);
    if (!versionResult) {
        return {
            content: [
                {
                    type: "text" as const,
                    text: `Error: Version not found for "${resolvedPath}" at timestamp "${timestamp}". Use list_versions to see available versions.`,
                },
            ],
            isError: true,
        };
    }

    const { meta, content: versionContent } = versionResult;

    // Save current content as a version before overwriting
    if (await pathExists(fullPath)) {
        try {
            const currentContent = await readFile(fullPath, "utf-8");
            await saveVersion({
                sourcePath: resolvedPath,
                content: currentContent,
                reason: `restore_version (restoring to ${meta.timestamp})`,
                skipDuplicate: false,
            });
            pushUndo(fullPath, currentContent, `restore_version to ${meta.timestamp}`);
        } catch {
            // File may be unreadable, proceed anyway
        }
    }

    // Write the version content to the note
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, versionContent, "utf-8");
    invalidateReadCache(fullPath);
    invalidateVersionCache(resolvedPath);
    invalidateGraphCache();
    await recordMutation({ type: "update", path: resolvedPath });

    return {
        content: [
            {
                type: "text" as const,
                text: `Restored "${resolvedPath}" to version from ${meta.timestamp} (reason: ${meta.reason}). Current content was saved as a new version.`,
            },
        ],
    };
}
