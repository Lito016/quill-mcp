/**
 * Append-only JSON audit log for memory mutations.
 * Records what changed, when, why, by whom, and the previous/new state.
 * Stored in .quill/audit.json within the vault.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { safeInternalPath } from "./vault.js";
import { getConfig } from "./config.js";

export type AuditAction =
    | "create"
    | "update"
    | "status_change"
    | "archive"
    | "supersede"
    | "resolve"
    | "consolidate_merge"
    | "consolidate_promote"
    | "consolidate_archive"
    | "conflict_detected"
    | "checkpoint_created"
    | "checkpoint_restored";

export interface AuditEntry {
    timestamp: string;
    actor: "agent" | "user" | "system";
    memoryId: string;
    action: AuditAction;
    previousState?: Record<string, unknown>;
    newState: Record<string, unknown>;
    reason?: string;
    sessionId?: string;
}

export interface AuditFilter {
    memoryId?: string;
    action?: AuditAction | AuditAction[];
    from?: string;
    to?: string;
    actor?: string;
    limit?: number;
}

const AUDIT_DIR = ".quill";
const AUDIT_FILE = "audit.json";

let auditCache: AuditEntry[] | undefined;

/**
 * Get the path to the audit log file.
 * Validates the configured audit directory is within the vault.
 */
async function getAuditPath(): Promise<string> {
    const validatedDir = await safeInternalPath(AUDIT_DIR);
    return join(validatedDir, AUDIT_FILE);
}

/**
 * Load the audit log from disk.
 */
async function loadAuditLog(): Promise<AuditEntry[]> {
    if (auditCache) return auditCache;

    const auditPath = await getAuditPath();
    try {
        const content = await readFile(auditPath, "utf-8");
        auditCache = JSON.parse(content) as AuditEntry[];
    } catch {
        auditCache = [];
    }
    return auditCache;
}

/**
 * Save the audit log to disk.
 */
async function saveAuditLog(entries: AuditEntry[]): Promise<void> {
    const auditPath = await getAuditPath();
    const dir = resolve(auditPath, "..");
    await mkdir(dir, { recursive: true });
    await writeFile(auditPath, JSON.stringify(entries, null, 2), "utf-8");
    auditCache = entries;
}

/**
 * Log a new audit entry.
 */
export async function logAuditEntry(entry: Omit<AuditEntry, "timestamp">): Promise<void> {
    const entries = await loadAuditLog();
    const fullEntry: AuditEntry = {
        ...entry,
        timestamp: new Date().toISOString(),
    };
    entries.push(fullEntry);

    // Check if rotation is needed
    const config = getConfig();
    if (config.audit.rotationEnabled) {
        const maxSize = config.audit.maxFileSizeMb * 1024 * 1024;
        const estimatedSize = JSON.stringify(entries).length;
        if (estimatedSize > maxSize) {
            // Rotate: keep the most recent half
            const keepCount = Math.floor(entries.length / 2);
            const rotated = entries.slice(-keepCount);
            await saveAuditLog(rotated);
            return;
        }
    }

    await saveAuditLog(entries);
}

/**
 * Query the audit log with filters.
 */
export async function queryAuditLog(filter: AuditFilter): Promise<AuditEntry[]> {
    let entries = await loadAuditLog();

    if (filter.memoryId) {
        entries = entries.filter((e) => e.memoryId === filter.memoryId);
    }
    if (filter.action) {
        const actions = Array.isArray(filter.action) ? filter.action : [filter.action];
        entries = entries.filter((e) => actions.includes(e.action));
    }
    if (filter.actor) {
        entries = entries.filter((e) => e.actor === filter.actor);
    }
    if (filter.from) {
        entries = entries.filter((e) => e.timestamp >= filter.from!);
    }
    if (filter.to) {
        entries = entries.filter((e) => e.timestamp <= filter.to!);
    }

    // Most recent first; ties (same-millisecond timestamps) broken by insertion
    // order so the result is deterministic for rapid successive writes
    entries
        .map((entry, index) => ({ entry, index }))
        .sort((a, b) => b.entry.timestamp.localeCompare(a.entry.timestamp) || b.index - a.index)
        .map(({ entry }) => entry)
        .forEach((entry, index) => {
            entries[index] = entry;
        });

    const limit = filter.limit ?? 50;
    return entries.slice(0, limit);
}

/**
 * Get all audit entries for a specific memory.
 */
export async function getAuditEntriesForMemory(memoryId: string): Promise<AuditEntry[]> {
    return queryAuditLog({ memoryId, limit: 1000 });
}

/**
 * Reset audit cache (for testing).
 */
export function resetAuditCache(): void {
    auditCache = undefined;
}
