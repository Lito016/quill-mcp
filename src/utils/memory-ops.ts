/**
 * High-level memory CRUD operations.
 * Provides create, read, update, delete, link, and supersession for memory files.
 * Integrates with metadata-index for querying and frontmatter for serialization.
 */

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import { getVaultRoot, pathExists, invalidateReadCache } from "./vault.js";
import { getConfig } from "./config.js";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.js";
import { generateMemoryId, isValidMemoryId } from "./memory-id.js";
import {
    applyDefaults,
    validateMemoryFrontmatter,
    isMemoryFrontmatter,
    MEMORY_STATUSES,
} from "./memory-schema.js";
import type { MemoryFrontmatter, MemoryType, MemoryStatus, SourceType, Importance } from "./memory-schema.js";
import { metadataIndex } from "./metadata-index.js";
import { recordMutation } from "./session-tracker.js";
import { moveToTrash } from "./trash.js";
import { logger } from "./logger.js";

// === TYPES ===

export interface CreateMemoryInput {
    type: MemoryType;
    project: string;
    content: string;
    id?: string;
    confidence?: number;
    source_type?: SourceType;
    source_reference?: string;
    importance?: Importance;
    entity?: string;
    tags?: string[];
    related?: string[];
    supersedes?: string;
}

export interface UpdateMemoryInput {
    id: string;
    type?: MemoryType;
    status?: MemoryStatus;
    confidence?: number;
    project?: string;
    content?: string;
    source_type?: SourceType;
    importance?: Importance;
    entity?: string;
    tags?: string[];
    related?: string[];
    supersedes?: string;
    superseded_by?: string;
}

export interface MemoryReadResult {
    frontmatter: MemoryFrontmatter;
    content: string;
    filePath: string;
}

// === INTERNAL HELPERS ===

/**
 * Get the absolute path to the memories directory.
 */
function getMemoriesDir(): string {
    const config = getConfig();
    return join(getVaultRoot(), config.memory.directories.memories);
}

/**
 * Resolve a memory file path by ID. Returns the absolute path if found, or undefined.
 * Searches the memories directory first, then falls back to a full vault scan.
 */
async function resolveMemoryPath(id: string): Promise<string | undefined> {
    const memoriesDir = getMemoriesDir();
    const directPath = join(memoriesDir, `${id}.md`);
    if (await pathExists(directPath)) {
        return directPath;
    }

    // Fallback: check the metadata index for the file path
    const meta = metadataIndex.getById(id);
    if (meta) {
        const indexPath = join(getVaultRoot(), meta.filePath);
        if (await pathExists(indexPath)) {
            return indexPath;
        }
    }

    return undefined;
}

/**
 * Serialize a memory to a markdown file string with frontmatter.
 */
function serializeMemory(frontmatter: MemoryFrontmatter, content: string): string {
    const fmRecord: Record<string, unknown> = {
        id: frontmatter.id,
        type: frontmatter.type,
        status: frontmatter.status,
        confidence: frontmatter.confidence,
        project: frontmatter.project,
        created: frontmatter.created,
        updated: frontmatter.updated,
        source_type: frontmatter.source_type,
        importance: frontmatter.importance,
        related: frontmatter.related,
        tags: frontmatter.tags,
    };

    // Only include optional fields if they have values
    if (frontmatter.source_reference) {
        fmRecord.source_reference = frontmatter.source_reference;
    }
    if (frontmatter.entity) {
        fmRecord.entity = frontmatter.entity;
    }
    if (frontmatter.supersedes) {
        fmRecord.supersedes = frontmatter.supersedes;
    }
    if (frontmatter.superseded_by) {
        fmRecord.superseded_by = frontmatter.superseded_by;
    }

    return stringifyFrontmatter(fmRecord) + "\n" + content;
}

// === PUBLIC API ===

/**
 * Create a new memory file.
 * Generates an ID if not provided, validates frontmatter, writes to disk,
 * and updates the metadata index.
 */
export async function createMemory(input: CreateMemoryInput): Promise<MemoryReadResult> {
    const now = new Date().toISOString();
    const id = input.id ?? generateMemoryId();

    // Validate custom ID if provided
    if (input.id && !isValidMemoryId(input.id)) {
        throw new Error(`Invalid memory ID format: "${input.id}". Expected mem_<ULID>.`);
    }

    // Build frontmatter with defaults
    const frontmatter = applyDefaults({
        id,
        type: input.type,
        project: input.project,
        confidence: input.confidence,
        source_type: input.source_type ?? "AGENT",
        importance: input.importance,
        entity: input.entity,
        tags: input.tags,
        related: input.related,
        supersedes: input.supersedes,
        created: now,
        updated: now,
    });

    // Validate
    const validation = validateMemoryFrontmatter(frontmatter);
    if (!validation.success) {
        const errors = validation.errors?.map((e) => `${e.field}: ${e.message}`).join(", ");
        throw new Error(`Invalid memory frontmatter: ${errors}`);
    }

    // Ensure memories directory exists
    const memoriesDir = getMemoriesDir();
    await mkdir(memoriesDir, { recursive: true });

    const filePath = join(memoriesDir, `${id}.md`);

    // Check for duplicate
    if (await pathExists(filePath)) {
        throw new Error(`Memory already exists with ID: ${id}`);
    }

    // Handle supersession: mark the old memory as superseded
    if (input.supersedes) {
        await markSuperseded(input.supersedes, id);
    }

    // Write file
    const fileContent = serializeMemory(frontmatter, input.content);
    await writeFile(filePath, fileContent, "utf-8");
    invalidateReadCache(filePath);

    // Update index
    const vaultRoot = getVaultRoot();
    await metadataIndex.updateEntry(filePath);

    // Record mutation
    const relPath = relative(vaultRoot, filePath).replace(/\\/g, "/");
    await recordMutation({ type: "create", path: relPath });

    logger.info("Memory created", { id, type: input.type, project: input.project });

    return { frontmatter, content: input.content, filePath };
}

/**
 * Read a memory file by ID.
 * Returns the parsed frontmatter and body content.
 */
export async function readMemory(id: string): Promise<MemoryReadResult> {
    const filePath = await resolveMemoryPath(id);
    if (!filePath) {
        throw new Error(`Memory not found: ${id}`);
    }

    const raw = await readFile(filePath, "utf-8");
    const { frontmatter, content } = parseFrontmatter(raw);

    if (!isMemoryFrontmatter(frontmatter)) {
        throw new Error(`File at "${filePath}" does not have valid memory frontmatter.`);
    }

    // Build a complete MemoryFrontmatter from parsed data
    const memFm: MemoryFrontmatter = {
        id: frontmatter.id as string,
        type: frontmatter.type as MemoryType,
        status: ((frontmatter.status as string) ?? "ACTIVE") as MemoryStatus,
        confidence: typeof frontmatter.confidence === "number" ? frontmatter.confidence : 0.8,
        project: (frontmatter.project as string) ?? "default",
        created: (frontmatter.created as string) ?? "",
        updated: (frontmatter.updated as string) ?? "",
        source_type: ((frontmatter.source_type as string) ?? "AGENT") as SourceType,
        source_reference: frontmatter.source_reference as string | undefined,
        importance: ((frontmatter.importance as string) ?? "NORMAL") as Importance,
        entity: frontmatter.entity as string | undefined,
        supersedes: frontmatter.supersedes as string | undefined,
        superseded_by: frontmatter.superseded_by as string | undefined,
        related: Array.isArray(frontmatter.related) ? (frontmatter.related as string[]) : [],
        tags: Array.isArray(frontmatter.tags) ? (frontmatter.tags as string[]) : [],
    };

    return { frontmatter: memFm, content: content.trim(), filePath };
}

/**
 * Update an existing memory file.
 * Only provided fields are updated. Auto-updates the `updated` timestamp.
 */
export async function updateMemory(input: UpdateMemoryInput): Promise<MemoryReadResult> {
    const existing = await readMemory(input.id);

    // Merge frontmatter
    const updatedFm: MemoryFrontmatter = {
        ...existing.frontmatter,
        updated: new Date().toISOString(),
    };

    if (input.type !== undefined) updatedFm.type = input.type;
    if (input.status !== undefined) updatedFm.status = input.status;
    if (input.confidence !== undefined) updatedFm.confidence = input.confidence;
    if (input.project !== undefined) updatedFm.project = input.project;
    if (input.source_type !== undefined) updatedFm.source_type = input.source_type;
    if (input.importance !== undefined) updatedFm.importance = input.importance;
    if (input.entity !== undefined) updatedFm.entity = input.entity;
    if (input.tags !== undefined) updatedFm.tags = input.tags;
    if (input.related !== undefined) updatedFm.related = input.related;
    if (input.superseded_by !== undefined) updatedFm.superseded_by = input.superseded_by;

    // Handle supersession
    if (input.supersedes !== undefined) {
        updatedFm.supersedes = input.supersedes;
        await markSuperseded(input.supersedes, input.id);
    }

    // Validate
    const validation = validateMemoryFrontmatter(updatedFm);
    if (!validation.success) {
        const errors = validation.errors?.map((e) => `${e.field}: ${e.message}`).join(", ");
        throw new Error(`Invalid memory frontmatter after update: ${errors}`);
    }

    const body = input.content !== undefined ? input.content : existing.content;
    const fileContent = serializeMemory(updatedFm, body);
    await writeFile(existing.filePath, fileContent, "utf-8");
    invalidateReadCache(existing.filePath);

    // Update index
    await metadataIndex.updateEntry(existing.filePath);

    // Record mutation
    const vaultRoot = getVaultRoot();
    const relPath = relative(vaultRoot, existing.filePath).replace(/\\/g, "/");
    await recordMutation({ type: "update", path: relPath });

    logger.info("Memory updated", { id: input.id });

    return { frontmatter: updatedFm, content: body, filePath: existing.filePath };
}

/**
 * Soft-delete a memory by moving it to .trash/.
 * Returns the trash path.
 */
export async function deleteMemory(id: string): Promise<string> {
    const filePath = await resolveMemoryPath(id);
    if (!filePath) {
        throw new Error(`Memory not found: ${id}`);
    }

    const trashPath = await moveToTrash(filePath);
    invalidateReadCache(filePath);

    // Invalidate from index
    metadataIndex.invalidate(filePath);

    // Record mutation
    const vaultRoot = getVaultRoot();
    const relPath = relative(vaultRoot, filePath).replace(/\\/g, "/");
    await recordMutation({ type: "delete", path: relPath });

    logger.info("Memory deleted", { id, trashPath });

    return trashPath;
}

/**
 * Link two memories by adding each to the other's `related` array.
 */
export async function linkMemories(
    sourceId: string,
    targetId: string,
): Promise<{ sourceRelated: string[]; targetRelated: string[] }> {
    if (sourceId === targetId) {
        throw new Error("Cannot link a memory to itself.");
    }

    const source = await readMemory(sourceId);
    const target = await readMemory(targetId);

    // Add target to source's related (if not already present)
    const sourceRelated = [...new Set([...source.frontmatter.related, targetId])];
    // Add source to target's related (if not already present)
    const targetRelated = [...new Set([...target.frontmatter.related, sourceId])];

    // Update both
    await updateMemory({ id: sourceId, related: sourceRelated });
    await updateMemory({ id: targetId, related: targetRelated });

    logger.info("Memories linked", { sourceId, targetId });

    return { sourceRelated, targetRelated };
}

/**
 * Mark a memory as superseded by another.
 * Sets its status to SUPERSEDED and its superseded_by field.
 */
async function markSuperseded(oldId: string, newId: string): Promise<void> {
    try {
        const old = await readMemory(oldId);
        // Prevent circular supersession
        if (old.frontmatter.superseded_by === newId) {
            return; // Already marked
        }
        if (old.frontmatter.superseded_by && old.frontmatter.superseded_by !== newId) {
            logger.warn("Memory already superseded", { oldId, existingSupersededBy: old.frontmatter.superseded_by });
        }
        await updateMemory({
            id: oldId,
            status: "SUPERSEDED",
            superseded_by: newId,
        } as UpdateMemoryInput);
    } catch {
        // Old memory might not exist — that's fine for forward references
        logger.warn("Could not mark memory as superseded", { oldId, newId });
    }
}

/**
 * Ensure the metadata index is initialized.
 * Tools call this before querying.
 */
export async function ensureIndexInitialized(): Promise<void> {
    if (!metadataIndex.isInitialized()) {
        await metadataIndex.initialize();
    }
}
