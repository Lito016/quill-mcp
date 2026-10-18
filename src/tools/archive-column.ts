import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { safeReadTarget, invalidateReadCache } from "../utils/vault.js";
import { parseBoard, serializeBoard, findColumn } from "../utils/kanban-parser.js";
import { kanbanIndex } from "../utils/kanban-index.js";
import * as z from "zod";

export const name = "archive_column";
export const description =
    "Archive all tasks in a column by moving them to an Archive section at the end of the board. " +
    "Archived tasks are marked with a timestamp. If no Archive column exists, one is created.";

export const inputSchema = z.object({
    path: z.string().describe("Path to the Kanban board file (relative to vault root)"),
    column: z.string().describe("Column name to archive (case-insensitive)"),
    archive_name: z
        .string()
        .default("Archive")
        .describe("Name of the archive column (default: Archive)"),
    clear_after: z
        .boolean()
        .default(true)
        .describe("If true, remove archived tasks from the source column after copying"),
});

export async function handler({
    path,
    column,
    archive_name,
    clear_after,
}: {
    path: string;
    column: string;
    archive_name: string;
    clear_after: boolean;
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

    const srcCol = findColumn(board, column);
    if (!srcCol) {
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

    if (srcCol.tasks.length === 0) {
        return {
            content: [
                {
                    type: "text" as const,
                    text: `Column "${column}" is already empty. Nothing to archive.`,
                },
            ],
        };
    }

    // Find or create archive column
    let archiveCol = findColumn(board, archive_name);
    if (!archiveCol) {
        archiveCol = {
            name: archive_name,
            tasks: [],
            index: board.columns.length,
        };
        board.columns.push(archiveCol);
    }

    const timestamp = new Date().toISOString().split("T")[0];
    const taskCount = srcCol.tasks.length;

    // Move tasks to archive
    for (const task of srcCol.tasks) {
        const archivedLine = task.rawLine + ` (archived: ${timestamp})`;
        archiveCol.tasks.push({
            ...task,
            rawLine: archivedLine,
            completed: true, // Mark as completed in archive
        });
    }

    if (clear_after) {
        srcCol.tasks = [];
    }

    const newContent = serializeBoard(board);
    await writeFile(fullPath, newContent, "utf-8");
    invalidateReadCache(fullPath);
    kanbanIndex.markDirty();

    return {
        content: [
            {
                type: "text" as const,
                text: `Archived ${taskCount} task(s) from "${srcCol.name}" to "${archiveCol.name}".`,
            },
        ],
    };
}
