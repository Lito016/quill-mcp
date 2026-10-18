import { listVersions, getVersionCount } from "../utils/version-store.js";
import { getCachedVersions, invalidateVersionCache } from "../utils/version-index.js";
import * as z from "zod";

export const name = "list_versions";
export const description =
    "List all saved versions of a note with timestamps, change reasons, content hashes, and sizes. " +
    "Versions are sorted newest first. Use read_version to view a specific version's content.";

export const inputSchema = z.object({
    path: z.string().describe("Path to the note file, relative to the vault root (.md appended if no extension)"),
    limit: z.number().min(1).max(100).optional().describe("Maximum number of versions to show (default: all, max 100)"),
});

export async function handler({ path, limit }: { path: string; limit?: number }) {
    const resolvedPath = path.endsWith(".md") ? path : `${path}.md`;

    // Invalidate cache to get fresh data for listing
    invalidateVersionCache(resolvedPath);
    const versions = await listVersions(resolvedPath);

    if (versions.length === 0) {
        return {
            content: [{ type: "text" as const, text: `No versions found for "${resolvedPath}".` }],
        };
    }

    const displayVersions = limit ? versions.slice(0, limit) : versions;

    const lines = [`Version history for "${resolvedPath}" (${versions.length} version(s)):`, ""];

    for (let i = 0; i < displayVersions.length; i++) {
        const v = displayVersions[i];
        const date = new Date(v.timestamp).toLocaleDateString("en-US", {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });
        const sizeStr = v.size < 1024 ? `${v.size} B` : `${(v.size / 1024).toFixed(1)} KB`;
        lines.push(`  ${i + 1}. ${date}`);
        lines.push(`     Reason: ${v.reason}`);
        lines.push(`     Hash: ${v.content_hash} | Size: ${sizeStr}`);
    }

    if (limit && versions.length > limit) {
        lines.push("");
        lines.push(`  ... and ${versions.length - limit} more version(s).`);
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}
