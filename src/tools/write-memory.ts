import * as z from "zod";
import { createMemory, updateMemory, ensureIndexInitialized } from "../utils/memory-ops.js";
import { MEMORY_TYPES, MEMORY_STATUSES, SOURCE_TYPES, IMPORTANCE_LEVELS } from "../utils/memory-schema.js";
import { isValidMemoryId } from "../utils/memory-id.js";

export const name = "write_memory";
export const description =
    "Create or update a structured memory file. Memories persist across sessions with typed metadata " +
    "(type, status, confidence, project, tags). Provide an existing ID to update, or omit to create new. " +
    "Memory types: " + MEMORY_TYPES.join(", ") + ".";

export const inputSchema = z.object({
    id: z
        .string()
        .optional()
        .describe("Existing memory ID to update. Omit to create a new memory."),
    type: z
        .enum(MEMORY_TYPES)
        .describe("Memory type. One of: " + MEMORY_TYPES.join(", ")),
    project: z.string().min(1).describe("Project name this memory belongs to."),
    content: z.string().describe("Markdown body content of the memory."),
    status: z
        .enum(MEMORY_STATUSES)
        .optional()
        .describe("Memory status (for updates). One of: " + MEMORY_STATUSES.join(", ")),
    confidence: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Confidence score 0.0–1.0. Default depends on source_type."),
    source_type: z
        .enum(SOURCE_TYPES)
        .optional()
        .describe("Origin of this memory. One of: " + SOURCE_TYPES.join(", ") + ". Default: AGENT."),
    importance: z
        .enum(IMPORTANCE_LEVELS)
        .optional()
        .describe("Importance level. One of: " + IMPORTANCE_LEVELS.join(", ") + ". Default: NORMAL."),
    entity: z.string().optional().describe("Optional entity name this memory relates to."),
    tags: z.array(z.string()).optional().describe("Tags for categorization and retrieval."),
    related: z.array(z.string()).optional().describe("IDs of related memories."),
    supersedes: z
        .string()
        .optional()
        .describe("ID of an older memory this one replaces. Sets the old one to SUPERSEDED status."),
});

export async function handler({
    id,
    type,
    project,
    content,
    status,
    confidence,
    source_type,
    importance,
    entity,
    tags,
    related,
    supersedes,
}: {
    id?: string;
    type: (typeof MEMORY_TYPES)[number];
    project: string;
    content: string;
    status?: (typeof MEMORY_STATUSES)[number];
    confidence?: number;
    source_type?: (typeof SOURCE_TYPES)[number];
    importance?: (typeof IMPORTANCE_LEVELS)[number];
    entity?: string;
    tags?: string[];
    related?: string[];
    supersedes?: string;
}) {
    await ensureIndexInitialized();

    try {
        // Validate ID format if provided
        if (id && !isValidMemoryId(id)) {
            return {
                content: [{ type: "text" as const, text: `Error: Invalid memory ID format: "${id}". Expected mem_<ULID>.` }],
                isError: true,
            };
        }

        if (id) {
            // Update existing memory
            const result = await updateMemory({
                id,
                type,
                project,
                content,
                status,
                confidence,
                source_type,
                importance,
                entity,
                tags,
                related,
                supersedes,
            });

            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Memory updated: ${result.frontmatter.id}\nType: ${result.frontmatter.type}, Status: ${result.frontmatter.status}, Project: ${result.frontmatter.project}`,
                    },
                ],
            };
        } else {
            // Create new memory
            const result = await createMemory({
                type,
                project,
                content,
                confidence,
                source_type,
                importance,
                entity,
                tags,
                related,
                supersedes,
            });

            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Memory created: ${result.frontmatter.id}\nType: ${result.frontmatter.type}, Status: ${result.frontmatter.status}, Project: ${result.frontmatter.project}`,
                    },
                ],
            };
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
    }
}
