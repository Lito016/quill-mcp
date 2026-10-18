import { readFile, writeFile } from "node:fs/promises";
import { resolveVaultPath, pathExists, invalidateReadCache } from "../utils/vault.js";
import { invalidateGraphCache } from "../utils/graph-cache.js";
import { pushUndo, popUndo, getUndoHistory, getUndoStats } from "../utils/undo-stack.js";
import * as z from "zod";

export const name = "note_undo";
export const description =
    "Undo or preview changes to a note. Modes: " +
    "'undo' reverts the last edit (up to 10 levels deep); " +
    "'history' shows the undo stack for a note; " +
    "'stats' shows overall undo stack summary. " +
    "All write tools (write_note, append_note, note_sections replace) automatically save undo history.";

export const inputSchema = z.object({
    path: z.string().optional().describe("Path to the note (required for 'undo' and 'history' modes)"),
    mode: z.enum(["undo", "history", "stats"]).describe("Operation mode"),
});

export async function handler({
    path,
    mode,
}: {
    path?: string;
    mode: "undo" | "history" | "stats";
}) {
    if (mode === "stats") {
        const stats = getUndoStats();
        const lines = [
            `Undo Stack Summary`,
            `  Total entries: ${stats.totalEntries}`,
            `  Files tracked: ${stats.files}`,
            `  Max per file: ${stats.maxPerFile}`,
            `  Max total: ${stats.maxTotal}`,
        ];
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }

    if (!path) {
        return {
            content: [{ type: "text" as const, text: `Error: 'path' is required for '${mode}' mode.` }],
            isError: true,
        };
    }

    const notePath = path.endsWith(".md") ? path : `${path}.md`;
    const fullPath = resolveVaultPath(notePath);

    if (!(await pathExists(fullPath))) {
        return {
            content: [{ type: "text" as const, text: `Error: Note not found at "${path}".` }],
            isError: true,
        };
    }

    if (mode === "history") {
        const history = getUndoHistory(fullPath);
        if (history.length === 0) {
            return {
                content: [{ type: "text" as const, text: `No undo history for "${path}".` }],
            };
        }

        const lines = [`Undo history for "${path}" (${history.length} version(s)):`, ""];
        for (let i = 0; i < history.length; i++) {
            const entry = history[i];
            const date = new Date(entry.timestamp).toISOString();
            lines.push(`  ${i + 1}. ${date} — ${entry.reason} (${entry.contentLength} chars)`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }

    if (mode === "undo") {
        const entry = popUndo(fullPath);
        if (!entry) {
            return {
                content: [{ type: "text" as const, text: `No undo history available for "${path}".` }],
                isError: true,
            };
        }

        // Save current content as redo potential
        const currentContent = await readFile(fullPath, "utf-8");
        pushUndo(fullPath, currentContent, `redo from undo at ${new Date().toISOString()}`);

        // Restore previous content
        await writeFile(fullPath, entry.content, "utf-8");
        invalidateReadCache(fullPath);
        invalidateGraphCache();

        const date = new Date(entry.timestamp).toISOString();
        return {
            content: [
                {
                    type: "text" as const,
                    text: `Undone: reverted "${path}" to version from ${date} (${entry.reason}).\nContent: ${entry.content.length} chars.`,
                },
            ],
        };
    }

    return {
        content: [{ type: "text" as const, text: `Error: Unknown mode "${mode}".` }],
        isError: true,
    };
}
