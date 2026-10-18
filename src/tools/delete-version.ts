import { deleteVersion, listVersions } from "../utils/version-store.js";
import { invalidateVersionCache } from "../utils/version-index.js";
import * as z from "zod";

export const name = "delete_version";
export const description =
    "Delete a specific version of a note (soft delete — moves to .trash/). " +
    "Use list_versions first to see available timestamps.";

export const inputSchema = z.object({
    path: z.string().describe("Path to the note file, relative to the vault root (.md appended if no extension)"),
    timestamp: z
        .string()
        .describe(
            "ISO timestamp of the version to delete (from list_versions output). " +
                "Partial timestamps are supported (prefix match).",
        ),
});

export async function handler({ path, timestamp }: { path: string; timestamp: string }) {
    const resolvedPath = path.endsWith(".md") ? path : `${path}.md`;

    const trashPath = await deleteVersion(resolvedPath, timestamp);

    if (!trashPath) {
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

    invalidateVersionCache(resolvedPath);

    return {
        content: [
            {
                type: "text" as const,
                text: `Version deleted for "${resolvedPath}" at timestamp "${timestamp}". Moved to .trash/ (recoverable via restore_note).`,
            },
        ],
    };
}
