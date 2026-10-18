import { extname } from "node:path";
import { safeReadTarget, cachedReadFile } from "../utils/vault.js";
import { parseFrontmatterPartial } from "../utils/frontmatter.js";
import { estimateTokens } from "../utils/tokens.js";
import * as z from "zod";

export const name = "read_note";
export const description =
    "Read the content of a note by its path relative to the vault root. " +
    "Auto-appends .md if no file extension is provided. " +
    "Supports line range reading, frontmatter-only mode, summary mode, and token budget truncation.";
export const inputSchema = z.object({
    path: z.string().describe("Path to the note file, relative to the vault root (.md appended if no extension)"),
    start_line: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Start reading from this line number (1-based, inclusive)"),
    end_line: z.number().int().positive().optional().describe("Stop reading at this line number (1-based, inclusive)"),
    frontmatter_only: z
        .boolean()
        .default(false)
        .describe("If true, return only the YAML frontmatter without body content"),
    summary: z
        .boolean()
        .default(false)
        .describe("If true, return first 20 lines + all headings (preview without full read)"),
    max_tokens: z.number().int().positive().optional().describe("Truncate output to fit within this token budget"),
});

export async function handler({
    path,
    start_line,
    end_line,
    frontmatter_only,
    summary,
    max_tokens,
}: {
    path: string;
    start_line?: number;
    end_line?: number;
    frontmatter_only: boolean;
    summary: boolean;
    max_tokens?: number;
}) {
    // Auto-append .md if no file extension is present
    const resolvedPath = extname(path) ? path : `${path}.md`;
    let fullPath: string;
    try {
        fullPath = await safeReadTarget(resolvedPath);
    } catch {
        return { content: [{ type: "text" as const, text: `Error: Note not found at "${path}".` }], isError: true };
    }

    // Frontmatter-only mode: use partial read (only first ~4KB) for speed
    if (frontmatter_only) {
        const { frontmatter } = await parseFrontmatterPartial(fullPath);
        if (Object.keys(frontmatter).length === 0) {
            return { content: [{ type: "text" as const, text: `No frontmatter found in "${path}".` }] };
        }
        const lines: string[] = [`Frontmatter for "${path}":`];
        for (const [key, value] of Object.entries(frontmatter)) {
            lines.push(`  ${key}: ${JSON.stringify(value)}`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }

    const content = await cachedReadFile(fullPath);

    let output = content;
    const allLines = content.split("\n");

    // Line range reading
    if (start_line !== undefined || end_line !== undefined) {
        const start = (start_line ?? 1) - 1; // Convert to 0-based
        const end = end_line ?? allLines.length;
        const sliced = allLines.slice(start, end);
        output = sliced.join("\n");
        const rangeInfo = `Lines ${start + 1}–${Math.min(end, allLines.length)} of ${allLines.length}:\n\n`;
        output = rangeInfo + output;
    }

    // Summary mode: first 20 lines + all headings
    if (summary && start_line === undefined && end_line === undefined) {
        const headings: string[] = [];
        for (let i = 0; i < allLines.length; i++) {
            if (/^#{1,6}\s/.test(allLines[i])) {
                headings.push(`  L${i + 1}: ${allLines[i].trim()}`);
            }
        }
        const preview = allLines.slice(0, 20).join("\n");
        const parts: string[] = [`Summary of "${path}" (${allLines.length} lines):`];
        parts.push(`\nPreview (first 20 lines):\n${preview}`);
        if (headings.length > 0) {
            parts.push(`\nHeadings (${headings.length}):\n${headings.join("\n")}`);
        }
        output = parts.join("\n");
    }

    // Token budget truncation
    if (max_tokens !== undefined) {
        const currentTokens = estimateTokens(output);
        if (currentTokens > max_tokens) {
            // Approximate chars per token (~4 chars/token)
            const maxChars = max_tokens * 4;
            output = output.slice(0, maxChars);
            output += `\n\n... [truncated: ${currentTokens} tokens exceeded budget of ${max_tokens}]`;
        }
    }

    return { content: [{ type: "text" as const, text: output }] };
}
