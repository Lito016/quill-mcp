import { readVersion } from "../utils/version-store.js";
import { estimateTokens, formatTokenEstimate } from "../utils/tokens.js";
import * as z from "zod";

export const name = "read_version";
export const description =
    "Read the content of a specific historical version of a note. " +
    "Use list_versions first to see available timestamps. " +
    "Returns the version content and metadata.";

export const inputSchema = z.object({
    path: z.string().describe("Path to the note file, relative to the vault root (.md appended if no extension)"),
    timestamp: z
        .string()
        .describe(
            "ISO timestamp of the version to read (from list_versions output). " +
                "Partial timestamps are supported (prefix match).",
        ),
    include_metadata: z.boolean().default(true).describe("If true, include version metadata in the output"),
});

export async function handler({
    path,
    timestamp,
    include_metadata,
}: {
    path: string;
    timestamp: string;
    include_metadata: boolean;
}) {
    const resolvedPath = path.endsWith(".md") ? path : `${path}.md`;
    const result = await readVersion(resolvedPath, timestamp);

    if (!result) {
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

    const { meta, content } = result;

    if (include_metadata) {
        const tokenEst = estimateTokens(content);
        const lines = [
            `Version of "${resolvedPath}"`,
            `Timestamp: ${meta.timestamp}`,
            `Reason: ${meta.reason}`,
            `Hash: ${meta.content_hash}`,
            `Size: ${meta.size} bytes (~${formatTokenEstimate(tokenEst)} tokens)`,
            "",
            "---",
            "",
            content,
        ];
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }

    return { content: [{ type: "text" as const, text: content }] };
}
