import * as z from "zod";
import { readMemory, ensureIndexInitialized } from "../utils/memory-ops.js";

export const name = "read_memory";
export const description =
    "Read a specific memory by its ID. Returns the full frontmatter metadata and body content. " +
    "Use list_memories to browse available IDs, or search_memories to find them.";

export const inputSchema = z.object({
    id: z.string().describe("The memory ID (format: mem_<ULID>) to read."),
});

export async function handler({ id }: { id: string }) {
    await ensureIndexInitialized();

    try {
        const result = await readMemory(id);
        const fm = result.frontmatter;

        const lines: string[] = [
            `Memory: ${fm.id}`,
            `Type: ${fm.type}`,
            `Status: ${fm.status}`,
            `Project: ${fm.project}`,
            `Confidence: ${fm.confidence}`,
            `Importance: ${fm.importance}`,
            `Source: ${fm.source_type}`,
            `Created: ${fm.created}`,
            `Updated: ${fm.updated}`,
        ];

        if (fm.entity) lines.push(`Entity: ${fm.entity}`);
        if (fm.tags.length > 0) lines.push(`Tags: ${fm.tags.join(", ")}`);
        if (fm.related.length > 0) lines.push(`Related: ${fm.related.join(", ")}`);
        if (fm.supersedes) lines.push(`Supersedes: ${fm.supersedes}`);
        if (fm.superseded_by) lines.push(`Superseded by: ${fm.superseded_by}`);

        lines.push("");
        lines.push("---");
        lines.push("");
        lines.push(result.content);

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
    }
}
