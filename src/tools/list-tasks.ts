import { taskIndex } from "../utils/task-index.js";
import type { TaskStatus, TaskPriority, ParsedTask } from "../utils/task-index.js";
import { MAX_PAGINATION_LIMIT } from "../utils/errors.js";
import * as z from "zod";

export const name = "list_tasks";
export const description =
    "List tasks across the vault with filtering. Scans all markdown files for checkboxes (- [ ] / - [x]). " +
    "Filter by status (pending/complete), project (folder path), tags, priority, and due date range. " +
    "Returns tasks with file location, description, and metadata.";

export const inputSchema = z.object({
    status: z.enum(["pending", "complete"]).optional().describe("Filter by task status"),
    project: z.string().optional().describe("Filter by project (folder path relative to vault root)"),
    tags: z.array(z.string()).optional().describe("Filter by tags (tasks must have ALL specified tags)"),
    priority: z.enum(["high", "medium", "low"]).optional().describe("Filter by priority level"),
    due_before: z.string().optional().describe("Only show tasks due before this date (YYYY-MM-DD)"),
    due_after: z.string().optional().describe("Only show tasks due on or after this date (YYYY-MM-DD)"),
    has_due_date: z.boolean().optional().describe("If true, only show tasks with a due date; if false, only tasks without"),
    sort: z
        .enum(["due_date", "priority", "file", "status"])
        .default("file")
        .describe("Sort order for results"),
    limit: z.number().max(MAX_PAGINATION_LIMIT).optional().describe(`Maximum number of tasks to return (max ${MAX_PAGINATION_LIMIT})`),
    offset: z.number().default(0).describe("Number of tasks to skip (for pagination)"),
});

export async function handler({
    status,
    project,
    tags,
    priority,
    due_before,
    due_after,
    has_due_date,
    sort,
    limit,
    offset,
}: {
    status?: "pending" | "complete";
    project?: string;
    tags?: string[];
    priority?: "high" | "medium" | "low";
    due_before?: string;
    due_after?: string;
    has_due_date?: boolean;
    sort: "due_date" | "priority" | "file" | "status";
    limit?: number;
    offset: number;
}) {
    const tasks = await taskIndex.getTasks({
        status: status as TaskStatus | undefined,
        project,
        tags,
        priority: priority as TaskPriority | undefined,
        dueBefore: due_before,
        dueAfter: due_after,
        hasDueDate: has_due_date,
    });

    if (tasks.length === 0) {
        const filterDesc = buildFilterDescription({ status, project, tags, priority, due_before, due_after, has_due_date });
        return {
            content: [{ type: "text" as const, text: `No tasks found${filterDesc}.` }],
        };
    }

    // Sort
    sortTasks(tasks, sort);

    const total = tasks.length;
    const paginated = limit ? tasks.slice(offset, offset + limit) : tasks.slice(offset);

    // Format output
    const formatted = paginated.map(formatTask);
    const resultText = formatted.join("\n");

    const isPaginated = limit !== undefined || offset > 0;
    const prefix = isPaginated
        ? `Showing ${paginated.length} of ${total} task(s):\n\n`
        : `Found ${total} task(s):\n\n`;

    return { content: [{ type: "text" as const, text: `${prefix}${resultText}` }] };
}

function formatTask(task: ParsedTask): string {
    const checkbox = task.status === "complete" ? "[x]" : "[ ]";
    const parts: string[] = [`${task.filePath}:${task.lineNum} - ${checkbox} ${task.description}`];

    const meta: string[] = [];
    if (task.dueDate) meta.push(`due: ${task.dueDate}`);
    if (task.priority) meta.push(`priority: ${task.priority}`);
    if (task.tags.length > 0) meta.push(`tags: ${task.tags.join(", ")}`);

    if (meta.length > 0) {
        parts.push(`  (${meta.join(" | ")})`);
    }

    return parts.join("");
}

function sortTasks(tasks: ParsedTask[], sort: string): void {
    switch (sort) {
        case "due_date":
            tasks.sort((a, b) => {
                if (!a.dueDate && !b.dueDate) return 0;
                if (!a.dueDate) return 1;
                if (!b.dueDate) return -1;
                return a.dueDate.localeCompare(b.dueDate);
            });
            break;
        case "priority": {
            const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
            tasks.sort((a, b) => {
                const aOrder = a.priority ? priorityOrder[a.priority] : 3;
                const bOrder = b.priority ? priorityOrder[b.priority] : 3;
                return aOrder - bOrder;
            });
            break;
        }
        case "status":
            tasks.sort((a, b) => {
                if (a.status === b.status) return a.filePath.localeCompare(b.filePath);
                return a.status === "pending" ? -1 : 1;
            });
            break;
        default: // file
            tasks.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.lineNum - b.lineNum);
            break;
    }
}

function buildFilterDescription(filters: {
    status?: string;
    project?: string;
    tags?: string[];
    priority?: string;
    due_before?: string;
    due_after?: string;
    has_due_date?: boolean;
}): string {
    const parts: string[] = [];
    if (filters.status) parts.push(`status=${filters.status}`);
    if (filters.project) parts.push(`project=${filters.project}`);
    if (filters.tags && filters.tags.length > 0) parts.push(`tags=[${filters.tags.join(",")}]`);
    if (filters.priority) parts.push(`priority=${filters.priority}`);
    if (filters.due_before) parts.push(`due_before=${filters.due_before}`);
    if (filters.due_after) parts.push(`due_after=${filters.due_after}`);
    if (filters.has_due_date !== undefined) parts.push(`has_due_date=${filters.has_due_date}`);

    if (parts.length === 0) return "";
    return ` matching filters: ${parts.join(", ")}`;
}
