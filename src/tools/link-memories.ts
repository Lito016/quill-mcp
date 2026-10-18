import * as z from "zod";
import { linkMemories, updateMemory, ensureIndexInitialized } from "../utils/memory-ops.js";

export const name = "link_memories";
export const description =
    "Create a relationship between two memories. Adds each memory to the other's 'related' list. " +
    "Supports relationship types: related (bidirectional), supersedes (one-way replacement). " +
    "Use this to build a graph of connected memories for better retrieval.";

export const inputSchema = z.object({
    source_id: z.string().describe("The source memory ID."),
    target_id: z.string().describe("The target memory ID."),
    relationship: z
        .enum(["related", "supersedes"])
        .default("related")
        .describe(
            "Type of relationship. 'related' creates a bidirectional link. " +
                "'supersedes' marks source as replacing target (sets target to SUPERSEDED status).",
        ),
});

export async function handler({
    source_id,
    target_id,
    relationship,
}: {
    source_id: string;
    target_id: string;
    relationship: "related" | "supersedes";
}) {
    await ensureIndexInitialized();

    try {
        if (source_id === target_id) {
            return {
                content: [{ type: "text" as const, text: "Error: Cannot link a memory to itself." }],
                isError: true,
            };
        }

        if (relationship === "supersedes") {
            // Source supersedes target: update source's supersedes field, mark target as SUPERSEDED
            await updateMemory({
                id: source_id,
                supersedes: target_id,
            });

            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Memory ${source_id} now supersedes ${target_id}.\n${target_id} status set to SUPERSEDED.`,
                    },
                ],
            };
        }

        // Bidirectional link
        const result = await linkMemories(source_id, target_id);

        return {
            content: [
                {
                    type: "text" as const,
                    text: `Memories linked bidirectionally.\n${source_id} related: [${result.sourceRelated.join(", ")}]\n${target_id} related: [${result.targetRelated.join(", ")}]`,
                },
            ],
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
    }
}
