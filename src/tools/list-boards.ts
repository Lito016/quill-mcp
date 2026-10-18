import { kanbanIndex } from "../utils/kanban-index.js";
import * as z from "zod";

export const name = "list_boards";
export const description =
    "List all Kanban boards in the vault. Shows board names, file paths, column counts, and task counts. " +
    "Boards are identified by type: kanban frontmatter or location in boards/ directory.";

export const inputSchema = z.object({
    include_stats: z
        .boolean()
        .default(true)
        .describe("If true, include column and task counts for each board"),
});

export async function handler({ include_stats }: { include_stats: boolean }) {
    const boards = await kanbanIndex.getAllBoards();

    if (boards.length === 0) {
        return {
            content: [
                {
                    type: "text" as const,
                    text: "No Kanban boards found. Create one with create_board or add type: kanban to frontmatter.",
                },
            ],
        };
    }

    const lines: string[] = [`Found ${boards.length} Kanban board(s):\n`];

    for (const board of boards) {
        const colCount = board.columns.length;
        const taskCount = board.columns.reduce((sum, col) => sum + col.tasks.length, 0);
        const pendingTasks = board.columns.reduce(
            (sum, col) => sum + col.tasks.filter((t) => !t.completed).length,
            0,
        );

        lines.push(`**${board.name}**`);
        lines.push(`  Path: ${board.filePath}`);

        if (include_stats) {
            lines.push(`  Columns: ${colCount} | Tasks: ${taskCount} (${pendingTasks} pending)`);
            const colNames = board.columns.map((c) => c.name).join(", ");
            lines.push(`  Column order: ${colNames}`);
        }

        lines.push("");
    }

    return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
    };
}
