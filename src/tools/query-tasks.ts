import { taskIndex } from "../utils/task-index.js";
import type { TaskStatus, TaskPriority, ParsedTask } from "../utils/task-index.js";
import { MAX_PAGINATION_LIMIT } from "../utils/errors.js";
import * as z from "zod";

export const name = "query_tasks";
export const description =
    "Advanced task queries with multiple combined filters and text search. " +
    "Supports combining status, project, tags, priority, due date range, and free-text search. " +
    "Returns a summary with counts and detailed task list. Use for complex task analysis.";

export const inputSchema = z.object({
    query: z.string().optional().describe("Free-text search in task descriptions"),
    status: z.enum(["pending", "complete"]).optional().describe("Filter by task status"),
    project: z.string().optional().describe("Filter by project folder (relative to vault root)"),
    tags: z.array(z.string()).optional().describe("Filter by tags (AND logic: tasks must have ALL tags)"),
    any_tag: z.boolean().default(false).describe("If true, match tasks with ANY of the specified tags (OR logic)"),
    priority: z.enum(["high", "medium", "low"]).optional().describe("Filter by priority level"),
    due_before: z.string().optional().describe("Tasks due before this date (YYYY-MM-DD, inclusive)"),
    due_after: z.string().optional().describe("Tasks due on or after this date (YYYY-MM-DD, inclusive)"),
    overdue: z.boolean().optional().describe("If true, only show tasks past their due date (pending tasks only)"),
    has_due_date: z.boolean().optional().describe("Filter tasks with/without a due date"),
    sort: z
        .enum(["due_date", "priority", "file", "status", "description"])
        .default("file")
        .describe("Sort order for results"),
    limit: z.number().max(MAX_PAGINATION_LIMIT).optional().describe(`Maximum results to return (max ${MAX_PAGINATION_LIMIT})`),
    offset: z.number().default(0).describe("Number of results to skip"),
    summary: z.boolean().default(true).describe("Include a summary with counts by status, priority, and project"),
});

export async function handler({
    query,
    status,
    project,
    tags,
    any_tag,
    priority,
    due_before,
    due_after,
    overdue,
    has_due_date,
    sort,
    limit,
    offset,
    summary,
}: {
    query?: string;
    status?: "pending" | "complete";
    project?: string;
    tags?: string[];
    any_tag: boolean;
    priority?: "high" | "medium" | "low";
    due_before?: string;
    due_after?: string;
    overdue?: boolean;
    has_due_date?: boolean;
    sort: "due_date" | "priority" | "file" | "status" | "description";
    limit?: number;
    offset: number;
    summary: boolean;
}) {
    // For overdue, we need pending tasks with due dates in the past
    const effectiveStatus = overdue ? "pending" : status;
    const today = new Date().toISOString().split("T")[0];

    let tasks = await taskIndex.getTasks({
        status: effectiveStatus as TaskStatus | undefined,
        project,
        tags: any_tag ? undefined : tags,
        priority: priority as TaskPriority | undefined,
        dueBefore: due_before,
        dueAfter: due_after,
        hasDueDate: has_due_date,
        query,
    });

    // Handle OR tag logic
    if (any_tag && tags && tags.length > 0) {
        const filterTags = tags.map((t) => t.toLowerCase());
        tasks = tasks.filter((t) => {
            const taskTags = t.tags.map((tag) => tag.toLowerCase());
            return filterTags.some((ft) => taskTags.includes(ft));
        });
    }

    // Handle overdue filter
    if (overdue) {
        tasks = tasks.filter((t) => t.dueDate !== null && t.dueDate < today);
    }

    if (tasks.length === 0) {
        return {
            content: [{ type: "text" as const, text: "No tasks match the query." }],
        };
    }

    // Sort
    sortTasks(tasks, sort);

    const total = tasks.length;
    const paginated = limit ? tasks.slice(offset, offset + limit) : tasks.slice(offset);

    // Build output
    const outputParts: string[] = [];

    // Summary section
    if (summary) {
        outputParts.push(buildSummary(tasks));
        outputParts.push("");
    }

    // Task list
    const formatted = paginated.map(formatTask);
    outputParts.push(...formatted);

    const resultText = outputParts.join("\n");
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
    if (task.dueDate) {
        const today = new Date().toISOString().split("T")[0];
        const isOverdue = task.status === "pending" && task.dueDate < today;
        meta.push(`due: ${task.dueDate}${isOverdue ? " (OVERDUE)" : ""}`);
    }
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
        case "description":
            tasks.sort((a, b) => a.description.localeCompare(b.description));
            break;
        default: // file
            tasks.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.lineNum - b.lineNum);
            break;
    }
}

function buildSummary(tasks: ParsedTask[]): string {
    const pending = tasks.filter((t) => t.status === "pending").length;
    const complete = tasks.length - pending;
    const overdue = tasks.filter(
        (t) => t.status === "pending" && t.dueDate !== null && t.dueDate < new Date().toISOString().split("T")[0],
    ).length;

    const lines: string[] = ["--- Summary ---"];
    lines.push(`Total: ${tasks.length} | Pending: ${pending} | Complete: ${complete}${overdue > 0 ? ` | Overdue: ${overdue}` : ""}`);

    // By priority
    const highCount = tasks.filter((t) => t.priority === "high" && t.status === "pending").length;
    const medCount = tasks.filter((t) => t.priority === "medium" && t.status === "pending").length;
    const lowCount = tasks.filter((t) => t.priority === "low" && t.status === "pending").length;
    if (highCount + medCount + lowCount > 0) {
        lines.push(`By priority (pending): high=${highCount}, medium=${medCount}, low=${lowCount}`);
    }

    // By project (top-level folder)
    const projectCounts = new Map<string, number>();
    for (const t of tasks) {
        const project = t.filePath.includes("/") ? t.filePath.split("/")[0] : "(root)";
        projectCounts.set(project, (projectCounts.get(project) ?? 0) + 1);
    }
    if (projectCounts.size > 1) {
        const sorted = [...projectCounts.entries()].sort((a, b) => b[1] - a[1]);
        lines.push(`By project: ${sorted.map(([p, c]) => `${p}(${c})`).join(", ")}`);
    }

    return lines.join("\n");
}
