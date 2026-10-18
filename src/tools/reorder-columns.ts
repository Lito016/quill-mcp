import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { safeReadTarget, invalidateReadCache } from "../utils/vault.js";
import { parseBoard, serializeBoard, reorderColumns } from "../utils/kanban-parser.js";
import { kanbanIndex } from "../utils/kanban-index.js";
import * as z from "zod";

export const name = "reorder_columns";
export const description =
    "Change the order of columns in a Kanban board. " +
    "Provide the desired column order as an array of column names. " +
    "Columns not included in the list are appended at the end.";

export const inputSchema = z.object({
    path: z.string().describe("Path to the Kanban board file (relative to vault root)"),
    columns: z
        .array(z.string())
        .describe("Desired column order (array of column names, case-insensitive matching)"),
});

export async function handler({
    path,
    columns,
}: {
    path: string;
    columns: string[];
}) {
    if (columns.length === 0) {
        return {
            content: [{ type: "text" as const, text: "Error: At least one column name is required." }],
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

    // Validate that all specified columns exist
    const existingNames = board.columns.map((c) => c.name.toLowerCase());
    for (const colName of columns) {
        if (!existingNames.includes(colName.toLowerCase())) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Error: Column "${colName}" not found. Available: ${board.columns.map((c) => c.name).join(", ")}`,
                    },
                ],
                isError: true,
            };
        }
    }

    const oldOrder = board.columns.map((c) => c.name);
    board.columns = reorderColumns(board.columns, columns);
    const newOrder = board.columns.map((c) => c.name);

    const newContent = serializeBoard(board);
    await writeFile(fullPath, newContent, "utf-8");
    invalidateReadCache(fullPath);
    kanbanIndex.markDirty();

    return {
        content: [
            {
                type: "text" as const,
                text: `Reordered columns in board "${board.name}".\nPrevious: ${oldOrder.join(" -> ")}\nNew: ${newOrder.join(" -> ")}`,
            },
        ],
    };
}
