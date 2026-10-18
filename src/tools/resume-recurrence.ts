/**
 * Resume a paused recurring task.
 *
 * Reactivates a paused recurring task. The next due date is preserved
 * from when it was paused, or recomputed from today if it's in the past.
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
    type RecurrenceState,
} from "../utils/recurring-engine.js";
import * as z from "zod";

export const name = "resume_recurrence";
export const description =
    "Resume a paused recurring task. Reactivates the task and preserves the next due date " +
    "if it's still in the future, or recomputes it from today if it has passed.";

export const inputSchema = z.object({
    task_id: z.string().optional().describe("The task ID (filePath:lineNum) to resume"),
    note: z.string().optional().describe("Path to the note containing the task"),
    line: z.number().int().positive().optional().describe("Line number of the task (1-based)"),
    search: z.string().optional().describe("Search text to find the recurring task by description"),
});

export async function handler({
    task_id,
    note,
    line,
    search,
}: {
    task_id?: string;
    note?: string;
    line?: number;
    search?: string;
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
        const searchLower = search.toLowerCase();
        entry = state.entries.find((e) => e.description.toLowerCase().includes(searchLower));
    }

    if (!entry) {
        return {
            content: [{ type: "text" as const, text: "Error: Recurring task not found in recurrence state." }],
            isError: true,
        };
    }

    if (!entry.paused) {
        return {
            content: [{ type: "text" as const, text: `Task "${entry.description}" is not paused.` }],
        };
    }

    entry.paused = false;

    // If the saved nextDue is in the past, recompute from today
    const today = todayStr();
    if (entry.nextDue < today) {
        const rule = parsePatternString(entry.pattern);
        if (rule) {
            entry.nextDue = computeNextDueDate(rule, fromDateStr(today));
        }
    }

    await saveRecurrenceState(state);

    return {
        content: [
            {
                type: "text" as const,
                text: `Recurring task resumed: "${entry.description}". Next due: ${entry.nextDue}.`,
            },
        ],
    };
}
