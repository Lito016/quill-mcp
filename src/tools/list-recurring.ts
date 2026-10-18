/**
 * List all recurring tasks with their next due dates and status.
 *
 * Shows recurring tasks from the vault along with their recurrence pattern,
 * next due date, and whether they are paused or overdue.
 */

import { taskIndex } from "../utils/task-index.js";
import type { ParsedTask } from "../utils/task-index.js";
import {
    loadRecurrenceState,
    computeNextDueDate,
    todayStr,
    isOverdue,
    type RecurrenceState,
} from "../utils/recurring-engine.js";
import { MAX_PAGINATION_LIMIT } from "../utils/errors.js";
import * as z from "zod";

export const name = "list_recurring";
export const description =
    "List all recurring tasks with their next due dates and status. " +
    "Shows recurrence pattern, next due date, and whether tasks are paused or overdue. " +
    "Filter by pattern type (daily/weekly/monthly) or status (active/paused/overdue).";

export const inputSchema = z.object({
    pattern_type: z
        .enum(["daily", "weekly", "monthly", "yearly", "custom"])
        .optional()
        .describe("Filter by recurrence pattern type"),
    status_filter: z
        .enum(["active", "paused", "overdue", "all"])
        .default("all")
        .describe("Filter by task status"),
    sort: z
        .enum(["next_due", "pattern", "file"])
        .default("next_due")
        .describe("Sort order for results"),
    limit: z.number().max(MAX_PAGINATION_LIMIT).optional().describe(`Maximum number of tasks to return (max ${MAX_PAGINATION_LIMIT})`),
    offset: z.number().default(0).describe("Number of tasks to skip (for pagination)"),
});

export async function handler({
    pattern_type,
    status_filter,
    sort,
    limit,
    offset,
}: {
    pattern_type?: "daily" | "weekly" | "monthly" | "yearly" | "custom";
    status_filter: "active" | "paused" | "overdue" | "all";
    sort: "next_due" | "pattern" | "file";
    limit?: number;
    offset: number;
}) {
    const tasks = await taskIndex.getRecurringTasks();

    if (tasks.length === 0) {
        return {
            content: [{ type: "text" as const, text: "No recurring tasks found." }],
        };
    }

    // Load recurrence state for additional metadata
    const state = await loadRecurrenceState();
    const today = todayStr();

    // Enrich tasks with computed next due dates and state
    const enriched = tasks.map((task) => {
        const stateEntry = findStateForTask(state, task);
        const nextDue = stateEntry?.nextDue ?? computeNextDueDate(task.recurrence!, new Date());
        const paused = stateEntry?.paused ?? false;
        const overdue = !paused && task.status === "pending" && isOverdue(nextDue);

        return {
            task,
            nextDue,
            paused,
            overdue,
            lastCompleted: stateEntry?.lastCompleted ?? null,
            skipCount: stateEntry?.skipCount ?? 0,
        };
    });

    // Apply filters
    let filtered = enriched;

    if (pattern_type) {
        filtered = filtered.filter((e) => e.task.recurrence?.type === pattern_type);
    }

    if (status_filter === "active") {
        filtered = filtered.filter((e) => !e.paused && e.task.status === "pending");
    } else if (status_filter === "paused") {
        filtered = filtered.filter((e) => e.paused);
    } else if (status_filter === "overdue") {
        filtered = filtered.filter((e) => e.overdue);
    }

    if (filtered.length === 0) {
        return {
            content: [{ type: "text" as const, text: `No recurring tasks match the filter: ${status_filter}.` }],
        };
    }

    // Sort
    sortEnriched(filtered, sort);

    const total = filtered.length;
    const paginated = limit ? filtered.slice(offset, offset + limit) : filtered.slice(offset);

    // Format output
    const formatted = paginated.map(formatRecurringTask);
    const resultText = formatted.join("\n");

    const isPaginated = limit !== undefined || offset > 0;
    const prefix = isPaginated
        ? `Showing ${paginated.length} of ${total} recurring task(s):\n\n`
        : `Found ${total} recurring task(s):\n\n`;

    return { content: [{ type: "text" as const, text: `${prefix}${resultText}` }] };
}

function findStateForTask(state: { entries: RecurrenceState[] }, task: ParsedTask): RecurrenceState | undefined {
    // Try to match by file path and approximate line number
    return state.entries.find(
        (e) => e.filePath === task.filePath && Math.abs(e.lineNum - task.lineNum) <= 1,
    );
}

function formatRecurringTask(entry: {
    task: ParsedTask;
    nextDue: string;
    paused: boolean;
    overdue: boolean;
    lastCompleted: string | null;
    skipCount: number;
}): string {
    const { task, nextDue, paused, overdue, lastCompleted, skipCount } = entry;
    const checkbox = task.status === "complete" ? "[x]" : "[ ]";
    const pattern = task.recurrence?.raw ?? "unknown";

    const parts: string[] = [`${task.filePath}:${task.lineNum} - ${checkbox} ${task.description}`];

    const meta: string[] = [`pattern: ${pattern}`, `next: ${nextDue}`];

    if (paused) meta.push("status: PAUSED");
    if (overdue) meta.push("status: OVERDUE");
    if (lastCompleted) meta.push(`last: ${lastCompleted.split("T")[0]}`);
    if (skipCount > 0) meta.push(`skipped: ${skipCount}`);
    if (task.priority) meta.push(`priority: ${task.priority}`);
    if (task.tags.length > 0) meta.push(`tags: ${task.tags.join(", ")}`);

    parts.push(`  (${meta.join(" | ")})`);
    return parts.join("");
}

function sortEnriched(
    entries: { task: ParsedTask; nextDue: string; paused: boolean; overdue: boolean }[],
    sort: string,
): void {
    switch (sort) {
        case "next_due":
            entries.sort((a, b) => a.nextDue.localeCompare(b.nextDue));
            break;
        case "pattern":
            entries.sort((a, b) => (a.task.recurrence?.type ?? "").localeCompare(b.task.recurrence?.type ?? ""));
            break;
        default: // file
            entries.sort((a, b) => a.task.filePath.localeCompare(b.task.filePath) || a.task.lineNum - b.task.lineNum);
            break;
    }
}
