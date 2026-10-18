import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { safeReadTarget, invalidateReadCache } from "../utils/vault.js";
import { parseBoard, serializeBoard, findColumn, buildTaskLine, type KanbanTask } from "../utils/kanban-parser.js";
import { kanbanIndex } from "../utils/kanban-index.js";
import * as z from "zod";

export const name = "add_to_column";
export const description =
    "Add a new task to a specific column in a Kanban board. " +
    "Supports task metadata: tags, priority, and due dates.";

export const inputSchema = z.object({
    path: z.string().describe("Path to the Kanban board file (relative to vault root)"),
    column: z.string().describe("Column name to add the task to (case-insensitive)"),
    description: z.string().min(1).max(500).describe("Task description text"),
    completed: z.boolean().default(false).describe("Whether the task starts as completed"),
    tags: z.array(z.string()).optional().describe("Tags for the task"),
    priority: z.enum(["high", "medium", "low"]).optional().describe("Task priority level"),
    due_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Due date in YYYY-MM-DD format"),
    position: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Position in column (0-based, default: end)"),
});

export async function handler({
    path,
    column,
    description,
    completed,
    tags,
    priority,
    due_date,
    position,
}: {
    path: string;
    column: string;
    description: string;
    completed: boolean;
    tags?: string[];
    priority?: "high" | "medium" | "low";
    due_date?: string;
    position?: number;
}) {
    const resolvedPath = extname(path) ? path : `${path}.md`;
    let fullPath: string;
    try {
        fullPath = await safeReadTarget(resolvedPath);
    } catch {
        return {
            content: [{ type: "text" as const, text: `Error: Board not found at "${resolvedPath}".` }],
            isError: true,
        };
    }

    const content = await readFile(fullPath, "utf-8");
    const board = parseBoard(content, resolvedPath);

    const col = findColumn(board, column);
    if (!col) {
        return {
            content: [
                {
                    type: "text" as const,
                    text: `Error: Column "${column}" not found. Available: ${board.columns.map((c) => c.name).join(", ")}`,
                },
            ],
            isError: true,
        };
    }

    const taskLine = buildTaskLine(description, completed, tags, priority || null, due_date || null);

    const newTask: KanbanTask = {
        description,
        completed,
        rawLine: taskLine,
        lineNum: 0,
        tags: tags || [],
        priority: priority || null,
        dueDate: due_date || null,
    };

    const insertPos = position !== undefined ? Math.min(position, col.tasks.length) : col.tasks.length;
    col.tasks.splice(insertPos, 0, newTask);

    const newContent = serializeBoard(board);
    await writeFile(fullPath, newContent, "utf-8");
    invalidateReadCache(fullPath);
    kanbanIndex.markDirty();

    const meta: string[] = [];
    if (due_date) meta.push(`due: ${due_date}`);
    if (tags && tags.length > 0) meta.push(`tags: ${tags.join(", ")}`);
    if (priority) meta.push(`priority: ${priority}`);
    const metaStr = meta.length > 0 ? ` (${meta.join(", ")})` : "";

    return {
        content: [
            {
                type: "text" as const,
                text: `Added task "${description}"${metaStr} to column "${col.name}" in board "${board.name}".`,
            },
        ],
    };
}
