/**
 * Pause a recurring task.
 *
 * Temporarily suspends a recurring task. While paused, the task will not
 * generate new occurrences and will be excluded from overdue calculations.
 */

import {
    loadRecurrenceState,
    saveRecurrenceState,
    findStateEntry,
    makeTaskId,
    type RecurrenceState,
} from "../utils/recurring-engine.js";
import * as z from "zod";

export const name = "pause_recurrence";
export const description =
    "Temporarily pause a recurring task. While paused, the task will not generate " +
    "new occurrences and will be excluded from overdue calculations. " +
    "Use resume_recurrence to reactivate the task.";

export const inputSchema = z.object({
    task_id: z.string().optional().describe("The task ID (filePath:lineNum) to pause"),
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
            content: [{ type: "text" as const, text: "Error: Recurring task not found in recurrence state. Complete the task at least once first." }],
            isError: true,
        };
    }

    if (entry.paused) {
        return {
            content: [{ type: "text" as const, text: `Task "${entry.description}" is already paused.` }],
        };
    }

    entry.paused = true;
    await saveRecurrenceState(state);

    return {
        content: [
            {
                type: "text" as const,
                text: `Recurring task paused: "${entry.description}". Next due was: ${entry.nextDue}.`,
            },
        ],
    };
}
