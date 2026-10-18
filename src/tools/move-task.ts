import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { safeReadTarget, invalidateReadCache } from "../utils/vault.js";
import { parseBoard, serializeBoard, findColumn, findTask, buildTaskLine } from "../utils/kanban-parser.js";
import { kanbanIndex } from "../utils/kanban-index.js";
import * as z from "zod";

export const name = "move_task";
export const description =
    "Move a task between columns in a Kanban board (drag-drop semantics). " +
    "Identify the task by description text (partial match) or by its current column and position. " +
    "Preserves task metadata (tags, priority, due dates).";

export const inputSchema = z.object({
    path: z.string().describe("Path to the Kanban board file (relative to vault root)"),
    task: z
        .string()
        .optional()
        .describe("Task description text to search for (partial, case-insensitive match)"),
    from_column: z.string().optional().describe("Source column name (required if task is ambiguous)"),
    to_column: z.string().describe("Destination column name"),
    position: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Position in destination column (0-based, default: end)"),
});

export async function handler({
    path,
    task,
    from_column,
    to_column,
    position,
}: {
    path: string;
    task?: string;
    from_column?: string;
    to_column: string;
    position?: number;
}) {
    if (!task && !from_column) {
        return {
            content: [
                {
                    type: "text" as const,
                    text: "Error: Either 'task' (description search) or 'from_column' must be provided.",
                },
            ],
            isError: true,
        };
    }

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

    // Find destination column
    const destCol = findColumn(board, to_column);
    if (!destCol) {
        return {
            content: [
                {
                    type: "text" as const,
                    text: `Error: Destination column "${to_column}" not found. Available: ${board.columns.map((c) => c.name).join(", ")}`,
                },
            ],
            isError: true,
        };
    }

    // Find the task to move
    let taskToMove: { task: typeof board.columns[0]["tasks"][0]; column: typeof board.columns[0] } | undefined;

    if (task) {
        if (from_column) {
            // Search within specific column
            const srcCol = findColumn(board, from_column);
            if (!srcCol) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Error: Source column "${from_column}" not found.`,
                        },
                    ],
                    isError: true,
                };
            }
            const lower = task.toLowerCase();
            const found = srcCol.tasks.find((t) => t.description.toLowerCase().includes(lower));
            if (found) {
                taskToMove = { task: found, column: srcCol };
            }
        } else {
            taskToMove = findTask(board, task);
        }
    }

    if (!taskToMove) {
        return {
            content: [
                {
                    type: "text" as const,
                    text: `Error: Task "${task}" not found${from_column ? ` in column "${from_column}"` : ""}.`,
                },
            ],
            isError: true,
        };
    }

    const { task: movingTask, column: srcCol } = taskToMove;

    // Don't move if already in destination
    if (srcCol.name === destCol.name) {
        return {
            content: [
                {
                    type: "text" as const,
                    text: `Task "${movingTask.description}" is already in column "${destCol.name}".`,
                },
            ],
        };
    }

    // Remove from source column
    const srcIdx = srcCol.tasks.indexOf(movingTask);
    srcCol.tasks.splice(srcIdx, 1);

    // Build new task line preserving metadata
    const newLine = buildTaskLine(
        movingTask.description,
        movingTask.completed,
        movingTask.tags.length > 0 ? movingTask.tags : undefined,
        movingTask.priority,
        movingTask.dueDate,
    );

    // Create updated task object
    const updatedTask = {
        ...movingTask,
        rawLine: newLine,
    };

    // Insert into destination column
    const insertPos = position !== undefined ? Math.min(position, destCol.tasks.length) : destCol.tasks.length;
    destCol.tasks.splice(insertPos, 0, updatedTask);

    // Write back
    const newContent = serializeBoard(board);
    await writeFile(fullPath, newContent, "utf-8");
    invalidateReadCache(fullPath);
    kanbanIndex.markDirty();

    return {
        content: [
            {
                type: "text" as const,
                text: `Moved "${movingTask.description}" from "${srcCol.name}" to "${destCol.name}"${position !== undefined ? ` at position ${position}` : ""}.`,
            },
        ],
    };
}
