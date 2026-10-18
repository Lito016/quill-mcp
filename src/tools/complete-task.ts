import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { pathExists, safeReadTarget, invalidateReadCache } from "../utils/vault.js";
import { taskIndex } from "../utils/task-index.js";
import * as z from "zod";

export const name = "complete_task";
export const description =
    "Mark a task as complete (or reopen a completed task) in a markdown note. " +
    "Identifies the task by file path and line number, or by searching for a matching description. " +
    "Toggles the markdown checkbox between - [ ] and - [x].";

export const inputSchema = z.object({
    note: z.string().describe("Path to the note containing the task (relative to vault root)"),
    line: z.number().int().positive().optional().describe("Line number of the task to toggle (1-based)"),
    search: z
        .string()
        .optional()
        .describe("Search text to find the task by description (matches first incomplete task containing this text)"),
    action: z
        .enum(["complete", "reopen"])
        .default("complete")
        .describe("Whether to mark the task complete or reopen it"),
});

export async function handler({
    note,
    line,
    search,
    action,
}: {
    note: string;
    line?: number;
    search?: string;
    action: "complete" | "reopen";
}) {
    if (line === undefined && !search) {
        return {
            content: [
                {
                    type: "text" as const,
                    text: "Error: Either 'line' or 'search' must be provided to identify the task.",
                },
            ],
            isError: true,
        };
    }

    const resolvedPath = extname(note) ? note : `${note}.md`;
    let fullPath: string;
    try {
        fullPath = await safeReadTarget(resolvedPath);
    } catch {
        return {
            content: [{ type: "text" as const, text: `Error: Note not found at "${resolvedPath}".` }],
            isError: true,
        };
    }

    const content = await readFile(fullPath, "utf-8");
    const lines = content.split("\n");

    let targetLineIdx: number | null = null;

    if (line !== undefined) {
        // Direct line number
        targetLineIdx = line - 1;
        if (targetLineIdx < 0 || targetLineIdx >= lines.length) {
            return {
                content: [{ type: "text" as const, text: `Error: Line ${line} is out of range (file has ${lines.length} lines).` }],
                isError: true,
            };
        }
        // Verify it's actually a task line
        if (!TASK_LINE_RE.test(lines[targetLineIdx])) {
            return {
                content: [{ type: "text" as const, text: `Error: Line ${line} is not a task checkbox.` }],
                isError: true,
            };
        }
    } else if (search) {
        // Search for matching task
        const searchLower = search.toLowerCase();
        for (let i = 0; i < lines.length; i++) {
            const match = lines[i].match(TASK_LINE_RE);
            if (!match) continue;

            const isComplete = match[2].toLowerCase() === "x";
            const taskText = match[3].toLowerCase();

            if (action === "complete" && !isComplete && taskText.includes(searchLower)) {
                targetLineIdx = i;
                break;
            }
            if (action === "reopen" && isComplete && taskText.includes(searchLower)) {
                targetLineIdx = i;
                break;
            }
        }

        if (targetLineIdx === null) {
            const actionWord = action === "complete" ? "incomplete" : "completed";
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Error: No ${actionWord} task matching "${search}" found in "${resolvedPath}".`,
                    },
                ],
                isError: true,
            };
        }
    }

    // Toggle the checkbox
    const originalLine = lines[targetLineIdx!];
    const match = originalLine.match(TASK_LINE_RE)!;
    const indent = match[1];
    const taskContent = match[3];

    let newLine: string;
    if (action === "complete") {
        newLine = `${indent}- [x] ${taskContent}`;
    } else {
        newLine = `${indent}- [ ] ${taskContent}`;
    }

    lines[targetLineIdx!] = newLine;
    const newContent = lines.join("\n");

    await writeFile(fullPath, newContent, "utf-8");
    invalidateReadCache(fullPath);
    taskIndex.markDirty();

    const actionPast = action === "complete" ? "completed" : "reopened";
    return {
        content: [
            {
                type: "text" as const,
                text: `Task ${actionPast} at ${resolvedPath}:${targetLineIdx! + 1}: "${taskContent}"`,
            },
        ],
    };
}

const TASK_LINE_RE = /^(\s*)- \[([ xX])\] (.+)$/;
