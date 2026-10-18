import { readFile, writeFile } from "node:fs/promises";
import { resolveVaultPath, pathExists, invalidateReadCache } from "../utils/vault.js";
import { invalidateGraphCache } from "../utils/graph-cache.js";
import { extractHeadings, findSectionByHeading, replaceSectionByHeading } from "../utils/sections.js";
import { pushUndo } from "../utils/undo-stack.js";
import * as z from "zod";

export const name = "note_sections";
export const description =
    "Navigate and edit notes by section. Three modes: " +
    "'outline' returns a structured heading outline without loading the full content; " +
    "'read' returns the content of a specific section identified by heading text; " +
    "'replace' replaces the body of a section (preserving the heading) with new content. " +
    "Use outline to inspect structure before reading, and read/replace for targeted edits.";

export const inputSchema = z.object({
    path: z.string().describe("Path to the note (relative to vault root, .md optional)"),
    mode: z
        .enum(["outline", "read", "replace"])
        .describe("Operation mode: outline (list headings), read (get section content), replace (update section)"),
    heading: z
        .string()
        .optional()
        .describe("Heading text to find (case-insensitive partial match). Required for 'read' and 'replace' modes."),
    content: z
        .string()
        .optional()
        .describe("New content for the section body (without the heading). Required for 'replace' mode."),
    max_level: z
        .number()
        .min(1)
        .max(6)
        .default(6)
        .describe("Maximum heading level to consider (default 6). E.g., 2 means only # and ## create sections."),
});

export async function handler({
    path,
    mode,
    heading,
    content,
    max_level,
}: {
    path: string;
    mode: "outline" | "read" | "replace";
    heading?: string;
    content?: string;
    max_level: number;
}) {
    const notePath = path.endsWith(".md") ? path : `${path}.md`;
    const fullPath = resolveVaultPath(notePath);

    if (!(await pathExists(fullPath))) {
        return {
            content: [{ type: "text" as const, text: `Error: Note not found at "${path}".` }],
            isError: true,
        };
    }

    const fileContent = await readFile(fullPath, "utf-8");

    // ── Outline mode ──────────────────────────────────────────────────
    if (mode === "outline") {
        const headings = extractHeadings(fileContent);

        if (headings.length === 0) {
            return {
                content: [{ type: "text" as const, text: `Note "${path}" has no headings.` }],
            };
        }

        const lines: string[] = [`Outline of "${path}" (${headings.length} heading(s)):`, ""];
        for (const h of headings) {
            const indent = "  ".repeat(h.level - 1);
            lines.push(`${indent}${"#".repeat(h.level)} ${h.text} (line ${h.line})`);
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }

    // ── Read mode ─────────────────────────────────────────────────────
    if (mode === "read") {
        if (!heading) {
            return {
                content: [{ type: "text" as const, text: "Error: 'heading' is required for 'read' mode." }],
                isError: true,
            };
        }

        const section = findSectionByHeading(fileContent, heading, max_level);
        if (!section) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Error: No section found matching heading "${heading}" (max level ${max_level}).`,
                    },
                ],
                isError: true,
            };
        }

        const lines: string[] = [
            `Section: ${section.heading!.raw}`,
            `Lines ${section.heading!.line}–${section.endLine} (${section.endLine - section.startLine} lines)`,
            "",
            section.content,
        ];

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }

    // ── Replace mode ──────────────────────────────────────────────────
    if (mode === "replace") {
        if (!heading) {
            return {
                content: [{ type: "text" as const, text: "Error: 'heading' is required for 'replace' mode." }],
                isError: true,
            };
        }
        if (content === undefined) {
            return {
                content: [{ type: "text" as const, text: "Error: 'content' is required for 'replace' mode." }],
                isError: true,
            };
        }

        const section = findSectionByHeading(fileContent, heading, max_level);
        if (!section) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Error: No section found matching heading "${heading}" (max level ${max_level}).`,
                    },
                ],
                isError: true,
            };
        }

        const newContent = replaceSectionByHeading(fileContent, heading, content, max_level);
        if (newContent === null) {
            return {
                content: [{ type: "text" as const, text: "Error: Failed to replace section content." }],
                isError: true,
            };
        }

        pushUndo(fullPath, fileContent, `note_sections replace "${heading}"`);
        await writeFile(fullPath, newContent, "utf-8");
        invalidateReadCache(fullPath);
        invalidateGraphCache();

        const oldLineCount = section.endLine - section.startLine;
        const newLineCount = content.split("\n").length + 1; // +1 for heading

        return {
            content: [
                {
                    type: "text" as const,
                    text: `Section "${section.heading!.text}" replaced successfully.\nOld: ${oldLineCount} lines → New: ${newLineCount} lines.`,
                },
            ],
        };
    }

    return {
        content: [{ type: "text" as const, text: `Error: Unknown mode "${mode}".` }],
        isError: true,
    };
}
