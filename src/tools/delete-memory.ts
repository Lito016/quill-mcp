import * as z from "zod";
import { deleteMemory, ensureIndexInitialized } from "../utils/memory-ops.js";

export const name = "delete_memory";
export const description =
    "Soft-delete a memory by moving it to .trash/ (recoverable via restore_note). " +
    "The memory is removed from the active index immediately.";

export const inputSchema = z.object({
    id: z.string().describe("The memory ID to delete."),
    dry_run: z.boolean().default(false).describe("If true, show what would be deleted without actually deleting."),
});

export async function handler({ id, dry_run }: { id: string; dry_run: boolean }) {
    await ensureIndexInitialized();

    try {
        if (dry_run) {
            // Just check if it exists
            const { readMemory } = await import("../utils/memory-ops.js");
            const mem = await readMemory(id);
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `[DRY RUN] Would delete memory: ${id}\nType: ${mem.frontmatter.type}, Project: ${mem.frontmatter.project}`,
                    },
                ],
            };
        }

        const trashPath = await deleteMemory(id);
        return {
            content: [
                {
                    type: "text" as const,
                    text: `Memory deleted: ${id}\nMoved to trash: ${trashPath}\nRecoverable via restore_note.`,
                },
            ],
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
    }
}
