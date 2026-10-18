/**
 * Persistent version store for note history.
 *
 * Stores versions in `.versions/<note-path>/<timestamp>.md` with YAML frontmatter
 * metadata. Auto-saves a version before each write/append operation (unless skipped).
 * Uses content hashing to avoid duplicate consecutive versions.
 *
 * Storage format:
 *   .versions/<note-relative-path>/<ISO-timestamp>.md
 *
 * Frontmatter:
 *   ---
 *   timestamp: "2024-01-15T10:30:00.000Z"
 *   source_path: "notes/example.md"
 *   reason: "write_note overwrite"
 *   content_hash: "abc123..."
 *   size: 1234
 *   ---
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile, rename, stat, rm } from "node:fs/promises";
import { join, dirname, relative, resolve } from "node:path";
import { getVaultRoot, pathExists, safeInternalPath, assertWithinRoot } from "./vault.js";
import { logger } from "./logger.js";

/** Default maximum versions per note. */
const DEFAULT_MAX_VERSIONS = 50;

/** Frontmatter delimiter. */
const FM_DELIM = "---";

export interface VersionMetadata {
    timestamp: string;
    source_path: string;
    reason: string;
    content_hash: string;
    size: number;
}

export interface VersionEntry extends VersionMetadata {
    /** Absolute path to the version file. */
    file_path: string;
    /** Relative path from vault root (e.g. ".versions/notes/example.md/2024-01-15T10-30-00.000Z.md"). */
    relative_path: string;
}

export interface SaveVersionOptions {
    /** Relative path of the source note (e.g. "notes/example.md"). */
    sourcePath: string;
    /** Full content to save as a version. */
    content: string;
    /** Reason for the change (e.g. "write_note overwrite"). */
    reason: string;
    /** Skip saving if content hash matches the most recent version (default: true). */
    skipDuplicate?: boolean;
    /** Maximum versions to keep for this note (default: 50). */
    maxVersions?: number;
}

/**
 * Compute SHA-256 hash of content string.
 */
export function contentHash(content: string): string {
    return createHash("sha256").update(content, "utf-8").digest("hex").slice(0, 16);
}

/**
 * Get the absolute path to the .versions directory.
 */
export function getVersionsPath(): string {
    return join(getVaultRoot(), ".versions");
}

/**
 * Get the absolute path to the versions directory for a specific note.
 */
function getNoteVersionsDir(sourcePath: string): string {
    return join(getVersionsPath(), sourcePath.replace(/\\/g, "/"));
}

/**
 * Serialize version metadata to YAML frontmatter + content.
 */
function serializeVersion(meta: VersionMetadata, content: string): string {
    const lines = [
        FM_DELIM,
        `timestamp: "${meta.timestamp}"`,
        `source_path: "${meta.source_path}"`,
        `reason: "${meta.reason.replace(/"/g, '\\"')}"`,
        `content_hash: "${meta.content_hash}"`,
        `size: ${meta.size}`,
        FM_DELIM,
        content,
    ];
    return lines.join("\n");
}

/**
 * Parse a version file into metadata and content.
 * Returns null if the file is malformed.
 */
export function parseVersionFile(raw: string): { meta: VersionMetadata; content: string } | null {
    if (!raw.startsWith(FM_DELIM)) return null;
    const secondDelim = raw.indexOf(`\n${FM_DELIM}`, FM_DELIM.length);
    if (secondDelim === -1) return null;

    const fmBlock = raw.slice(FM_DELIM.length + 1, secondDelim);
    const content = raw.slice(secondDelim + 4).replace(/^\n/, ""); // skip \n--- and leading newline

    const meta: VersionMetadata = {
        timestamp: "",
        source_path: "",
        reason: "",
        content_hash: "",
        size: 0,
    };

    for (const line of fmBlock.split("\n")) {
        const match = line.match(/^(\w+):\s*"?(.*?)"?\s*$/);
        if (!match) continue;
        const [, key, value] = match;
        switch (key) {
            case "timestamp":
                meta.timestamp = value;
                break;
            case "source_path":
                meta.source_path = value;
                break;
            case "reason":
                meta.reason = value.replace(/\\"/g, '"');
                break;
            case "content_hash":
                meta.content_hash = value;
                break;
            case "size":
                meta.size = parseInt(value, 10) || 0;
                break;
        }
    }

    if (!meta.timestamp || !meta.source_path) return null;
    return { meta, content };
}

/**
 * Save a version snapshot for a note.
 * Creates the version directory if needed, writes the version file,
 * and prunes old versions if over the limit.
 *
 * Returns the VersionEntry if saved, or null if skipped (duplicate).
 */
export async function saveVersion(options: SaveVersionOptions): Promise<VersionEntry | null> {
    const { sourcePath, content, reason, skipDuplicate = true, maxVersions = DEFAULT_MAX_VERSIONS } = options;
    const versionsDir = getNoteVersionsDir(sourcePath);
    const hash = contentHash(content);

    // Check for duplicate: skip if latest version has same hash
    if (skipDuplicate) {
        const existing = await listVersions(sourcePath);
        if (existing.length > 0 && existing[0].content_hash === hash) {
            return null; // Content unchanged, skip
        }
    }

    // Ensure directory exists
    await mkdir(versionsDir, { recursive: true });

    // Validate the versions directory is within the vault
    const versionsRoot = getVersionsPath();
    await assertWithinRoot(versionsDir, getVaultRoot());

    // ISO timestamp with colons replaced for filesystem safety
    const timestamp = new Date().toISOString();
    const safeTimestamp = timestamp.replace(/[:.]/g, "-");
    const fileName = `${safeTimestamp}.md`;
    const filePath = join(versionsDir, fileName);

    const meta: VersionMetadata = {
        timestamp,
        source_path: sourcePath,
        reason,
        content_hash: hash,
        size: Buffer.byteLength(content, "utf-8"),
    };

    const serialized = serializeVersion(meta, content);

    // Atomic write: write to temp then rename
    const tmpPath = `${filePath}.tmp.${process.pid}`;
    await writeFile(tmpPath, serialized, "utf-8");
    await rename(tmpPath, filePath);

    // Prune old versions if over limit
    await pruneVersions(sourcePath, maxVersions);

    const relPath = relative(getVaultRoot(), filePath).replace(/\\/g, "/");
    logger.debug("Version saved", { sourcePath, timestamp, hash });

    return { ...meta, file_path: filePath, relative_path: relPath };
}

/**
 * List all versions of a note, sorted newest first.
 */
export async function listVersions(sourcePath: string): Promise<VersionEntry[]> {
    const versionsDir = getNoteVersionsDir(sourcePath);

    if (!(await pathExists(versionsDir))) {
        return [];
    }

    const entries: VersionEntry[] = [];
    let files: string[];

    try {
        const dirEntries = await readdir(versionsDir);
        files = dirEntries.filter((f) => f.endsWith(".md")).sort().reverse();
    } catch {
        return [];
    }

    for (const fileName of files) {
        const filePath = join(versionsDir, fileName);
        try {
            const raw = await readFile(filePath, "utf-8");
            const parsed = parseVersionFile(raw);
            if (parsed) {
                const relPath = relative(getVaultRoot(), filePath).replace(/\\/g, "/");
                entries.push({
                    ...parsed.meta,
                    file_path: filePath,
                    relative_path: relPath,
                });
            }
        } catch {
            // Skip corrupted version files
            logger.warn("Skipping corrupted version file", { filePath });
        }
    }

    return entries;
}

/**
 * Read the content of a specific version by timestamp.
 * The timestamp can be the full ISO string or the filename (without .md).
 */
export async function readVersion(sourcePath: string, timestamp: string): Promise<{ meta: VersionMetadata; content: string } | null> {
    const versionsDir = getNoteVersionsDir(sourcePath);

    // Try to find the version file
    const safeTimestamp = timestamp.replace(/[:.]/g, "-");
    const fileName = safeTimestamp.endsWith(".md") ? safeTimestamp : `${safeTimestamp}.md`;
    const filePath = join(versionsDir, fileName);

    if (!(await pathExists(filePath))) {
        // Try to find by partial match
        const versions = await listVersions(sourcePath);
        const match = versions.find((v) => v.timestamp === timestamp || v.timestamp.startsWith(timestamp));
        if (!match) return null;
        const raw = await readFile(match.file_path, "utf-8");
        return parseVersionFile(raw);
    }

    const raw = await readFile(filePath, "utf-8");
    return parseVersionFile(raw);
}

/**
 * Read the raw content of a version file (without frontmatter).
 */
export async function readVersionContent(sourcePath: string, timestamp: string): Promise<string | null> {
    const result = await readVersion(sourcePath, timestamp);
    return result?.content ?? null;
}

/**
 * Prune old versions for a note, keeping only the newest `maxVersions`.
 */
export async function pruneVersions(sourcePath: string, maxVersions: number = DEFAULT_MAX_VERSIONS): Promise<number> {
    const versionsDir = getNoteVersionsDir(sourcePath);

    if (!(await pathExists(versionsDir))) return 0;

    let files: string[];
    try {
        const dirEntries = await readdir(versionsDir);
        files = dirEntries.filter((f) => f.endsWith(".md")).sort();
    } catch {
        return 0;
    }

    if (files.length <= maxVersions) return 0;

    const toRemove = files.slice(0, files.length - maxVersions);
    let pruned = 0;

    for (const fileName of toRemove) {
        try {
            await rm(join(versionsDir, fileName));
            pruned++;
        } catch {
            // Skip files that can't be removed
        }
    }

    if (pruned > 0) {
        logger.debug("Pruned old versions", { sourcePath, pruned, remaining: files.length - pruned });
    }

    return pruned;
}

/**
 * Get version count for a note.
 */
export async function getVersionCount(sourcePath: string): Promise<number> {
    const versionsDir = getNoteVersionsDir(sourcePath);
    if (!(await pathExists(versionsDir))) return 0;

    try {
        const entries = await readdir(versionsDir);
        return entries.filter((f) => f.endsWith(".md")).length;
    } catch {
        return 0;
    }
}

/**
 * Delete a specific version file (moves to .trash/).
 * Returns the trash path if successful.
 */
export async function deleteVersion(sourcePath: string, timestamp: string): Promise<string | null> {
    const versionsDir = getNoteVersionsDir(sourcePath);
    const safeTimestamp = timestamp.replace(/[:.]/g, "-");
    const fileName = safeTimestamp.endsWith(".md") ? safeTimestamp : `${safeTimestamp}.md`;
    const filePath = join(versionsDir, fileName);

    if (!(await pathExists(filePath))) {
        // Try partial match
        const versions = await listVersions(sourcePath);
        const match = versions.find((v) => v.timestamp === timestamp || v.timestamp.startsWith(timestamp));
        if (!match) return null;
        return moveToTrashVersion(match.file_path);
    }

    return moveToTrashVersion(filePath);
}

/**
 * Move a version file to .trash/ for soft deletion.
 */
async function moveToTrashVersion(filePath: string): Promise<string> {
    const { moveToTrash } = await import("./trash.js");
    return moveToTrash(filePath);
}

/**
 * Get all note paths that have versions.
 */
export async function listVersionedNotes(): Promise<string[]> {
    const versionsRoot = getVersionsPath();
    if (!(await pathExists(versionsRoot))) return [];

    const notes: string[] = [];

    async function scanDir(dir: string): Promise<void> {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
                await scanDir(fullPath);
            } else if (entry.isFile() && entry.name.endsWith(".md")) {
                const relPath = relative(versionsRoot, fullPath).replace(/\\/g, "/");
                notes.push(relPath);
            }
        }
    }

    await scanDir(versionsRoot);
    return notes;
}
