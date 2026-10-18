import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { safeReadTarget } from "../utils/vault.js";
import { parseBoard } from "../utils/kanban-parser.js";
import * as z from "zod";

export const name = "read_board";
export const description =
    "Read the full state of a Kanban board, including all columns and their tasks. " +
    "Shows task completion status, tags, priority, and due dates.";

export const inputSchema = z.object({
    path: z.string().describe("Path to the Kanban board file (relative to vault root)"),
    compact: z
        .boolean()
        .default(false)
        .describe("If true, show compact view (column names and task counts only)"),
});

export async function handler({ path, compact }: { path: string; compact: boolean }) {
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

    if (board.columns.length === 0) {
        return {
            content: [
                {
                    type: "text" as const,
                    text: `Board "${board.name}" at "${resolvedPath}" has no columns. Add H2 headings to define columns.`,
                },
            ],
        };
    }

    const lines: string[] = [];
    lines.push(`# ${board.name}`);
    lines.push(`Path: ${resolvedPath}\n`);

    for (const col of board.columns) {
        const total = col.tasks.length;
        const completed = col.tasks.filter((t) => t.completed).length;
        const pending = total - completed;

        if (compact) {
            lines.push(`## ${col.name} (${total} tasks, ${pending} pending)`);
        } else {
            lines.push(`## ${col.name} [${completed}/${total} done]`);
            if (total === 0) {
                lines.push("  (empty)");
            } else {
                for (const task of col.tasks) {
                    const status = task.completed ? "x" : " ";
                    const meta: string[] = [];
                    if (task.priority) meta.push(`[${task.priority}]`);
                    if (task.dueDate) meta.push(`due: ${task.dueDate}`);
                    if (task.tags.length > 0) meta.push(`tags: ${task.tags.join(", ")}`);
                    const metaStr = meta.length > 0 ? ` ${meta.join(" ")}` : "";
                    lines.push(`  - [${status}] ${task.description}${metaStr}`);
                }
            }
        }
        lines.push("");
    }

    return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
    };
}
