/**
 * Skip one occurrence of a recurring task.
 *
 * Advances the next due date to the next occurrence without marking the
 * current task as complete. Useful for holidays or when a task is not applicable.
 */

import {
    loadRecurrenceState,
    saveRecurrenceState,
    findStateEntry,
    computeNextDueDate,
    parsePatternString,
    fromDateStr,
    todayStr,
    makeTaskId,
    upsertStateEntry,
    type RecurrenceState,
} from "../utils/recurring-engine.js";
import * as z from "zod";

export const name = "skip_recurrence";
export const description =
    "Skip one occurrence of a recurring task without completing it. " +
    "Advances the next due date to the following occurrence. " +
    "Useful for holidays or when a task is not applicable for a specific period.";

export const inputSchema = z.object({
    task_id: z.string().optional().describe("The task ID (filePath:lineNum) to skip"),
    note: z.string().optional().describe("Path to the note containing the task"),
    line: z.number().int().positive().optional().describe("Line number of the task (1-based)"),
    search: z.string().optional().describe("Search text to find the recurring task by description"),
    count: z.number().int().positive().max(52).default(1).describe("Number of occurrences to skip (default: 1, max: 52)"),
});

export async function handler({
    task_id,
    note,
    line,
    search,
    count,
}: {
    task_id?: string;
    note?: string;
    line?: number;
    search?: string;
    count: number;
}) {
    const state = await loadRecurrenceState();

    let entry: RecurrenceState | undefined;

    if (task_id) {
        entry = findStateEntry(state, task_id);
    } else if (note && line) {
        const resolvedNote = note.endsWith(".md") ? note : `${note}.md`;
        const id = makeTaskId(resolvedNote, line);
        entry = findStateEntry(state, id);
    } else if (search) {
        // Search by description in state entries
        const searchLower = search.toLowerCase();
        entry = state.entries.find((e) => e.description.toLowerCase().includes(searchLower));
    }

    if (!entry) {
        return {
            content: [{ type: "text" as const, text: "Error: Recurring task not found in recurrence state. Complete the task at least once first." }],
            isError: true,
        };
    }

    if (entry.paused) {
        return {
            content: [{ type: "text" as const, text: `Error: Task "${entry.description}" is paused. Resume it before skipping.` }],
            isError: true,
        };
    }

    const rule = parsePatternString(entry.pattern);
    if (!rule) {
        return {
            content: [{ type: "text" as const, text: `Error: Invalid recurrence pattern "${entry.pattern}".` }],
            isError: true,
        };
    }

    // Advance the next due date by `count` occurrences
    let currentDue = fromDateStr(entry.nextDue);
    for (let i = 0; i < count; i++) {
        const nextStr = computeNextDueDate(rule, currentDue);
        currentDue = fromDateStr(nextStr);
    }

    entry.nextDue = currentDue.toISOString().split("T")[0];
    entry.skipCount += count;
    upsertStateEntry(state, entry);
    await saveRecurrenceState(state);

    const skipWord = count === 1 ? "occurrence" : "occurrences";
    return {
        content: [
            {
                type: "text" as const,
                text: `Skipped ${count} ${skipWord} for "${entry.description}". Next due: ${entry.nextDue}.`,
            },
        ],
    };
}
