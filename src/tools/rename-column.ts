import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { safeReadTarget, invalidateReadCache } from "../utils/vault.js";
import { parseBoard, serializeBoard, findColumn } from "../utils/kanban-parser.js";
import { kanbanIndex } from "../utils/kanban-index.js";
import * as z from "zod";

export const name = "rename_column";
export const description =
    "Rename a column in a Kanban board. Column matching is case-insensitive. " +
    "Updates the frontmatter columns list and the H2 heading.";

export const inputSchema = z.object({
    path: z.string().describe("Path to the Kanban board file (relative to vault root)"),
    column: z.string().describe("Current column name (case-insensitive)"),
    new_name: z.string().min(1).max(200).describe("New column name"),
});

export async function handler({
    path,
    column,
    new_name,
}: {
    path: string;
    column: string;
    new_name: string;
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

    // Check if new name conflicts with existing column
    const conflict = findColumn(board, new_name);
    if (conflict && conflict.name !== col.name) {
        return {
            content: [
                {
                    type: "text" as const,
                    text: `Error: Column "${new_name}" already exists.`,
                },
            ],
            isError: true,
        };
    }

    const oldName = col.name;
    col.name = new_name;

    const newContent = serializeBoard(board);
    await writeFile(fullPath, newContent, "utf-8");
    invalidateReadCache(fullPath);
    kanbanIndex.markDirty();

    return {
        content: [
            {
                type: "text" as const,
                text: `Renamed column "${oldName}" to "${new_name}" in board "${board.name}".`,
            },
        ],
    };
}
