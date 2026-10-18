/**
 * Complete a recurring task and auto-create the next occurrence.
 *
 * When a recurring task is completed:
 * 1. Marks the current task as complete ([x])
 * 2. Updates the recurrence state with last completion date
 * 3. Computes the next due date based on the recurrence pattern
 * 4. Inserts a new pending task with the next due date
 */

import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { pathExists, safeReadTarget, invalidateReadCache } from "../utils/vault.js";
import { taskIndex } from "../utils/task-index.js";
import {
    parseRecurrencePattern,
    computeNextDueDate,
    loadRecurrenceState,
    saveRecurrenceState,
    upsertStateEntry,
    makeTaskId,
    todayStr,
    fromDateStr,
    type RecurrenceState,
} from "../utils/recurring-engine.js";
import * as z from "zod";

export const name = "complete_recurring";
export const description =
    "Complete a recurring task and automatically create the next occurrence. " +
    "Marks the current task as done and inserts a new pending task with the next due date " +
    "based on the recurrence pattern (daily, weekly, monthly, etc.).";

export const inputSchema = z.object({
    note: z.string().describe("Path to the note containing the recurring task (relative to vault root)"),
    line: z.number().int().positive().optional().describe("Line number of the task to complete (1-based)"),
    search: z
        .string()
        .optional()
        .describe("Search text to find the task by description (matches first incomplete recurring task)"),
});

export async function handler({
    note,
    line,
    search,
}: {
    note: string;
    line?: number;
    search?: string;
}) {
    if (line === undefined && !search) {
        return {
            content: [{ type: "text" as const, text: "Error: Either 'line' or 'search' must be provided." }],
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
    const TASK_LINE_RE = /^(\s*)- \[([ xX])\] (.+)$/;

    if (line !== undefined) {
        targetLineIdx = line - 1;
        if (targetLineIdx < 0 || targetLineIdx >= lines.length) {
            return {
                content: [{ type: "text" as const, text: `Error: Line ${line} is out of range.` }],
                isError: true,
            };
        }
        if (!TASK_LINE_RE.test(lines[targetLineIdx])) {
            return {
                content: [{ type: "text" as const, text: `Error: Line ${line} is not a task.` }],
                isError: true,
            };
        }
    } else if (search) {
        const searchLower = search.toLowerCase();
        for (let i = 0; i < lines.length; i++) {
            const match = lines[i].match(TASK_LINE_RE);
            if (!match) continue;
            const isComplete = match[2].toLowerCase() === "x";
            const taskText = match[3].toLowerCase();
            if (!isComplete && taskText.includes(searchLower)) {
                // Verify it has a recurrence pattern
                const rule = parseRecurrencePattern(match[3]);
                if (rule) {
                    targetLineIdx = i;
                    break;
                }
            }
        }

        if (targetLineIdx === null) {
            return {
                content: [{ type: "text" as const, text: `Error: No incomplete recurring task matching "${search}" found.` }],
                isError: true,
            };
        }
    }

    const originalLine = lines[targetLineIdx!];
    const match = originalLine.match(TASK_LINE_RE)!;
    const indent = match[1];
    const taskContent = match[3];

    // Parse the recurrence pattern
    const rule = parseRecurrencePattern(taskContent);
    if (!rule) {
        return {
            content: [{ type: "text" as const, text: "Error: This task does not have a recurrence pattern." }],
            isError: true,
        };
    }

    // Mark current task as complete
    const completedLine = `${indent}- [x] ${taskContent}`;
    lines[targetLineIdx!] = completedLine;

    // Compute next due date
    const today = todayStr();
    const nextDue = computeNextDueDate(rule, fromDateStr(today));

    // Build the new task line with the next due date
    const dueDateEmoji = "\u{1F4C5}";
    const newTaskLine = `${indent}- [ ] ${taskContent} ${dueDateEmoji} ${nextDue}`;

    // Insert the new task line right after the completed one
    lines.splice(targetLineIdx! + 1, 0, newTaskLine);

    const newContent = lines.join("\n");
    await writeFile(fullPath, newContent, "utf-8");
    invalidateReadCache(fullPath);
    taskIndex.markDirty();

    // Update recurrence state
    const state = await loadRecurrenceState();
    const taskId = makeTaskId(resolvedPath, targetLineIdx! + 1);
    const stateEntry: RecurrenceState = {
        taskId,
        lastCompleted: new Date().toISOString(),
        nextDue,
        paused: false,
        skipCount: 0,
        pattern: rule.raw,
        description: taskContent,
        filePath: resolvedPath,
        lineNum: targetLineIdx! + 1,
    };
    upsertStateEntry(state, stateEntry);
    await saveRecurrenceState(state);

    return {
        content: [
            {
                type: "text" as const,
                text: `Recurring task completed. Next occurrence due: ${nextDue}. New task inserted at line ${targetLineIdx! + 2}.`,
            },
        ],
    };
}
