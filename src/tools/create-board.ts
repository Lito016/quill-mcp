import { writeFile, mkdir } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { pathExists, resolveVaultPath, invalidateReadCache } from "../utils/vault.js";
import { kanbanIndex } from "../utils/kanban-index.js";
import { serializeBoard, type KanbanBoard } from "../utils/kanban-parser.js";
import { stringifyFrontmatter } from "../utils/frontmatter.js";
import * as z from "zod";

export const name = "create_board";
export const description =
    "Create a new Kanban board with specified columns. " +
    "Boards are markdown files with H2 sections as columns and checkbox items as tasks. " +
    "Default columns: Todo, In Progress, Done. Board is created in boards/ directory by default.";

export const inputSchema = z.object({
    board_name: z.string().min(1).max(200).describe("Name of the Kanban board"),
    path: z
        .string()
        .optional()
        .describe(
            "File path relative to vault root (default: boards/<board-name>.md). Auto-appends .md if needed.",
        ),
    columns: z
        .array(z.string())
        .default(["Todo", "In Progress", "Done"])
        .describe("Column names in order (default: [Todo, In Progress, Done])"),
    description: z.string().optional().describe("Optional description to add below the board title"),
});

export async function handler({
    board_name,
    path,
    columns,
    description,
}: {
    board_name: string;
    path?: string;
    columns: string[];
    description?: string;
}) {
    if (columns.length === 0) {
        return {
            content: [{ type: "text" as const, text: "Error: At least one column is required." }],
            isError: true,
        };
    }

    // Determine file path
    const slug = board_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const resolvedPath = path ? (extname(path) ? path : `${path}.md`) : `boards/${slug}.md`;
    const fullPath = resolveVaultPath(resolvedPath);

    if (await pathExists(fullPath)) {
        return {
            content: [{ type: "text" as const, text: `Error: Board already exists at "${resolvedPath}".` }],
            isError: true,
        };
    }

    const now = new Date().toISOString();
    const frontmatter: Record<string, unknown> = {
        type: "kanban",
        columns,
        created: now,
        updated: now,
    };

    // Build board content
    const board: KanbanBoard = {
        name: board_name,
        columns: columns.map((col, idx) => ({ name: col, tasks: [], index: idx })),
        frontmatter,
        filePath: resolvedPath,
    };

    let content = serializeBoard(board);

    // Add description after title if provided
    if (description) {
        const lines = content.split("\n");
        const titleIdx = lines.findIndex((l) => l.startsWith("# "));
        if (titleIdx !== -1) {
            lines.splice(titleIdx + 1, 0, "", description);
            content = lines.join("\n");
        }
    }

    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
    invalidateReadCache(fullPath);
    kanbanIndex.markDirty();

    const colList = columns.join(", ");
    return {
        content: [
            {
                type: "text" as const,
                text: `Kanban board "${board_name}" created at "${resolvedPath}" with columns: ${colList}`,
            },
        ],
    };
}
