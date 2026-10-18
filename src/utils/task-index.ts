/**
 * Task index: parses markdown checkboxes from vault files, maintains an
 * in-memory task list, and supports filtering by status, project, tags,
 * priority, and due date.
 *
 * Integrates with the file watcher for cache invalidation.
 */

import { readdir, readFile, lstat, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { getVaultRoot } from "./vault.js";
import { logger } from "./logger.js";
import { parseRecurrencePattern, hasRecurrence, type RecurrenceRule } from "./recurring-engine.js";

// ─── Types ────────────────────────────────────────────────────────────

export type TaskStatus = "pending" | "complete";
export type TaskPriority = "high" | "medium" | "low" | null;

export interface ParsedTask {
    /** Vault-relative path of the file containing this task. */
    filePath: string;
    /** 1-based line number within the file. */
    lineNum: number;
    /** Raw markdown line (trimmed). */
    rawLine: string;
    /** Whether the checkbox is checked. */
    status: TaskStatus;
    /** The task description text (without checkbox or metadata emojis). */
    description: string;
    /** Due date in YYYY-MM-DD format, if present. */
    dueDate: string | null;
    /** Tags extracted from the task line. */
    tags: string[];
    /** Priority level, if specified. */
    priority: TaskPriority;
    /** Recurrence rule, if this is a recurring task. */
    recurrence: RecurrenceRule | null;
}

export interface TaskFilter {
    status?: TaskStatus;
    project?: string;
    tags?: string[];
    priority?: TaskPriority;
    dueBefore?: string;
    dueAfter?: string;
    hasDueDate?: boolean;
    query?: string;
}

// ─── Regex Patterns ───────────────────────────────────────────────────

/** Matches `- [ ]` or `- [x]` (case-insensitive for the x). */
const TASK_LINE_RE = /^(\s*)- \[([ xX])\] (.+)$/;

/** Due date emoji: 📅 YYYY-MM-DD */
const DUE_DATE_RE = /\u{1F4C5}\s*(\d{4}-\d{2}-\d{2})/u;

/** Tags emoji: 🏷️ tag1,tag2 */
const TAGS_RE = /\u{1F3F7}\u{FE0F}?\s*([\w][\w,\s/-]*)/u;

/** Priority emoji: 📌 high|medium|low */
const PRIORITY_RE = /\u{1F4CC}\s*(high|medium|low)/u;

// ─── Task Index Class ─────────────────────────────────────────────────

class TaskIndex {
    private tasks: ParsedTask[] = [];
    private dirty = true;
    /** Track file mtimes to detect staleness without full rescan. */
    private fileSnapshots: Map<string, number> = new Map();

    /**
     * Mark the index as dirty (needs rescan on next access).
     * Called by the file watcher when .md files change.
     */
    markDirty(): void {
        this.dirty = true;
    }

    /**
     * Invalidate a specific file path. Forces re-parse of that file.
     */
    invalidatePath(relPath: string): void {
        this.dirty = true;
        this.fileSnapshots.delete(relPath);
    }

    /**
     * Ensure the index is up-to-date. Performs a full vault scan if dirty.
     */
    async ensureSynchronized(): Promise<void> {
        if (!this.dirty) return;
        await this.rebuildIndex();
        this.dirty = false;
    }

    /**
     * Get all tasks (ensures index is synchronized first).
     */
    async getAllTasks(): Promise<ParsedTask[]> {
        await this.ensureSynchronized();
        return [...this.tasks];
    }

    /**
     * Get tasks matching the given filters.
     */
    async getTasks(filter: TaskFilter = {}): Promise<ParsedTask[]> {
        await this.ensureSynchronized();
        return this.applyFilters(filter);
    }

    /**
     * Get index statistics.
     */
    async getStats(): Promise<{ totalTasks: number; pending: number; complete: number; filesScanned: number }> {
        await this.ensureSynchronized();
        const pending = this.tasks.filter((t) => t.status === "pending").length;
        return {
            totalTasks: this.tasks.length,
            pending,
            complete: this.tasks.length - pending,
            filesScanned: this.fileSnapshots.size,
        };
    }

    /**
     * Get all recurring tasks (tasks with a recurrence pattern).
     */
    async getRecurringTasks(): Promise<ParsedTask[]> {
        await this.ensureSynchronized();
        return this.tasks.filter((t) => t.recurrence !== null);
    }

    // ─── Internal ─────────────────────────────────────────────────────

    private async rebuildIndex(): Promise<void> {
        const vaultRoot = getVaultRoot();
        const allTasks: ParsedTask[] = [];
        const currentFiles = new Set<string>();

        await this.scanForTasks(vaultRoot, allTasks, currentFiles);

        this.tasks = allTasks;

        // Clean up snapshots for deleted files
        for (const key of this.fileSnapshots.keys()) {
            if (!currentFiles.has(key)) {
                this.fileSnapshots.delete(key);
            }
        }

        logger.debug("Task index rebuilt", {
            totalTasks: allTasks.length,
            filesScanned: currentFiles.size,
        });
    }

    private async scanForTasks(dir: string, tasks: ParsedTask[], trackedFiles: Set<string>): Promise<void> {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (
                entry.name === ".trash" ||
                entry.name === ".quill-sessions" ||
                entry.name === "node_modules" ||
                entry.name === ".git"
            ) {
                continue;
            }

            const fullPath = join(dir, entry.name);

            // Symlink defense
            try {
                const entryStat = await lstat(fullPath);
                if (entryStat.isSymbolicLink()) continue;

                if (entryStat.isDirectory()) {
                    await this.scanForTasks(fullPath, tasks, trackedFiles);
                    continue;
                }
            } catch {
                continue;
            }

            // Only process .md files
            if (!entry.name.endsWith(".md")) continue;

            const relPath = relative(getVaultRoot(), fullPath).replace(/\\/g, "/");

            // Check if file has changed since last parse
            try {
                const fileStat = await stat(fullPath);
                const mtime = fileStat.mtimeMs;
                const prevMtime = this.fileSnapshots.get(relPath);

                if (prevMtime === mtime && !this.dirty) {
                    // File unchanged, keep existing tasks for this file
                    trackedFiles.add(relPath);
                    continue;
                }

                const content = await readFile(fullPath, "utf-8");
                const fileTasks = parseTasksFromFile(content, relPath);
                this.fileSnapshots.set(relPath, mtime);
                trackedFiles.add(relPath);

                // Remove old tasks from this file, add new ones
                tasks.push(...fileTasks);
            } catch {
                // Skip unreadable files
            }
        }
    }

    private applyFilters(filter: TaskFilter): ParsedTask[] {
        let result = this.tasks;

        if (filter.status) {
            result = result.filter((t) => t.status === filter.status);
        }

        if (filter.project) {
            const projectPrefix = filter.project.replace(/\/+$/, "");
            result = result.filter((t) => {
                const dir = t.filePath.includes("/") ? t.filePath.substring(0, t.filePath.lastIndexOf("/")) : "";
                return dir === projectPrefix || dir.startsWith(`${projectPrefix}/`);
            });
        }

        if (filter.tags && filter.tags.length > 0) {
            const filterTags = filter.tags.map((t) => t.toLowerCase());
            result = result.filter((t) => {
                const taskTags = t.tags.map((tag) => tag.toLowerCase());
                return filterTags.every((ft) => taskTags.includes(ft));
            });
        }

        if (filter.priority) {
            result = result.filter((t) => t.priority === filter.priority);
        }

        if (filter.hasDueDate === true) {
            result = result.filter((t) => t.dueDate !== null);
        } else if (filter.hasDueDate === false) {
            result = result.filter((t) => t.dueDate === null);
        }

        if (filter.dueBefore) {
            result = result.filter((t) => t.dueDate !== null && t.dueDate <= filter.dueBefore!);
        }

        if (filter.dueAfter) {
            result = result.filter((t) => t.dueDate !== null && t.dueDate >= filter.dueAfter!);
        }

        if (filter.query) {
            const queryLower = filter.query.toLowerCase();
            result = result.filter((t) => t.description.toLowerCase().includes(queryLower));
        }

        return result;
    }
}

// ─── Parsing Helpers ──────────────────────────────────────────────────

/**
 * Parse all tasks from a markdown file's content.
 */
export function parseTasksFromFile(content: string, filePath: string): ParsedTask[] {
    const lines = content.split("\n");
    const tasks: ParsedTask[] = [];

    for (let i = 0; i < lines.length; i++) {
        const task = parseTaskLine(lines[i], filePath, i + 1);
        if (task) {
            tasks.push(task);
        }
    }

    return tasks;
}

/**
 * Parse a single line for a task checkbox. Returns null if not a task line.
 */
export function parseTaskLine(line: string, filePath: string, lineNum: number): ParsedTask | null {
    const match = line.match(TASK_LINE_RE);
    if (!match) return null;

    const status: TaskStatus = match[2].toLowerCase() === "x" ? "complete" : "pending";
    const rawContent = match[3];

    // Extract metadata from the raw content
    const dueDate = extractDueDate(rawContent);
    const tags = extractTags(rawContent);
    const priority = extractPriority(rawContent);
    const recurrence = parseRecurrencePattern(rawContent);
    const description = extractDescription(rawContent);

    return {
        filePath,
        lineNum,
        rawLine: line.trim(),
        status,
        description,
        dueDate,
        tags,
        priority,
        recurrence,
    };
}

/**
 * Extract the due date from a task line.
 */
export function extractDueDate(line: string): string | null {
    const match = line.match(DUE_DATE_RE);
    return match ? match[1] : null;
}

/**
 * Extract tags from a task line.
 */
export function extractTags(line: string): string[] {
    const match = line.match(TAGS_RE);
    if (!match) return [];
    return match[1]
        .split(/[,\s]+/)
        .map((t) => t.trim())
        .filter(Boolean);
}

/**
 * Extract priority from a task line.
 */
export function extractPriority(line: string): TaskPriority {
    const match = line.match(PRIORITY_RE);
    if (!match) return null;
    return match[1] as TaskPriority;
}

/**
 * Extract the clean description text, stripping metadata emojis.
 */
export function extractDescription(rawContent: string): string {
    let desc = rawContent;
    // Remove due date emoji + date
    desc = desc.replace(/\s*\u{1F4C5}\s*\d{4}-\d{2}-\d{2}/u, "");
    // Remove tags emoji + tags
    desc = desc.replace(/\s*\u{1F3F7}\u{FE0F}?\s*[\w][\w,\s/-]*/u, "");
    // Remove priority emoji + level
    desc = desc.replace(/\s*\u{1F4CC}\s*(high|medium|low)/u, "");
    // Remove recurrence emoji + pattern
    desc = desc.replace(/\s*\u{1F504}\s*\S+/u, "");
    return desc.trim();
}

/**
 * Build a markdown task line from components.
 */
export function buildTaskLine(
    description: string,
    status: TaskStatus = "pending",
    dueDate?: string | null,
    tags?: string[],
    priority?: TaskPriority,
): string {
    const checkbox = status === "complete" ? "[x]" : "[ ]";
    let line = `- ${checkbox} ${description}`;

    if (dueDate) {
        line += ` \u{1F4C5} ${dueDate}`;
    }
    if (tags && tags.length > 0) {
        line += ` \u{1F3F7}\u{FE0F} ${tags.join(",")}`;
    }
    if (priority) {
        line += ` \u{1F4CC} ${priority}`;
    }

    return line;
}

// ─── Singleton ────────────────────────────────────────────────────────

export const taskIndex = new TaskIndex();
