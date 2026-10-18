/**
 * Kanban board index: discovers and caches all Kanban boards in the vault.
 * Boards are identified by:
 *   - `type: kanban` in frontmatter, OR
 *   - Being located in a `boards/` directory
 *
 * Integrates with the file watcher for cache invalidation.
 */

import { readdir, readFile, lstat, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { getVaultRoot } from "./vault.js";
import { parseBoard, isKanbanContent, type KanbanBoard } from "./kanban-parser.js";
import { logger } from "./logger.js";

// ─── Board Index Class ────────────────────────────────────────────────

class KanbanIndex {
    private boards: Map<string, KanbanBoard> = new Map();
    private dirty = true;
    private fileSnapshots: Map<string, number> = new Map();

    /**
     * Mark the index as dirty (needs rescan on next access).
     */
    markDirty(): void {
        this.dirty = true;
    }

    /**
     * Invalidate a specific file path.
     */
    invalidatePath(relPath: string): void {
        this.dirty = true;
        this.fileSnapshots.delete(relPath);
        this.boards.delete(relPath);
    }

    /**
     * Ensure the index is up-to-date.
     */
    async ensureSynchronized(): Promise<void> {
        if (!this.dirty) return;
        await this.rebuildIndex();
        this.dirty = false;
    }

    /**
     * Get all indexed boards.
     */
    async getAllBoards(): Promise<KanbanBoard[]> {
        await this.ensureSynchronized();
        return Array.from(this.boards.values());
    }

    /**
     * Get a specific board by file path (vault-relative).
     */
    async getBoard(filePath: string): Promise<KanbanBoard | undefined> {
        await this.ensureSynchronized();
        return this.boards.get(filePath);
    }

    /**
     * Get board count.
     */
    async getBoardCount(): Promise<number> {
        await this.ensureSynchronized();
        return this.boards.size;
    }

    /**
     * Get index statistics.
     */
    async getStats(): Promise<{
        totalBoards: number;
        totalColumns: number;
        totalTasks: number;
        filesScanned: number;
    }> {
        await this.ensureSynchronized();
        let totalColumns = 0;
        let totalTasks = 0;
        for (const board of this.boards.values()) {
            totalColumns += board.columns.length;
            for (const col of board.columns) {
                totalTasks += col.tasks.length;
            }
        }
        return {
            totalBoards: this.boards.size,
            totalColumns,
            totalTasks,
            filesScanned: this.fileSnapshots.size,
        };
    }

    // ─── Internal ─────────────────────────────────────────────────────

    private async rebuildIndex(): Promise<void> {
        const vaultRoot = getVaultRoot();
        const currentFiles = new Set<string>();

        await this.scanForBoards(vaultRoot, currentFiles);

        // Clean up snapshots for deleted files
        for (const key of this.fileSnapshots.keys()) {
            if (!currentFiles.has(key)) {
                this.fileSnapshots.delete(key);
                this.boards.delete(key);
            }
        }

        logger.debug("Kanban index rebuilt", {
            totalBoards: this.boards.size,
            filesScanned: currentFiles.size,
        });
    }

    private async scanForBoards(dir: string, trackedFiles: Set<string>): Promise<void> {
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
                entry.name === ".git" ||
                entry.name === ".versions"
            ) {
                continue;
            }

            const fullPath = join(dir, entry.name);

            // Symlink defense
            try {
                const entryStat = await lstat(fullPath);
                if (entryStat.isSymbolicLink()) continue;

                if (entryStat.isDirectory()) {
                    await this.scanForBoards(fullPath, trackedFiles);
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
                    trackedFiles.add(relPath);
                    continue;
                }

                const content = await readFile(fullPath, "utf-8");
                this.fileSnapshots.set(relPath, mtime);
                trackedFiles.add(relPath);

                // Check if this is a kanban board
                const isInBoardsDir = relPath.startsWith("boards/") || relPath.includes("/boards/");
                if (isInBoardsDir || isKanbanContent(content)) {
                    const board = parseBoard(content, relPath);
                    this.boards.set(relPath, board);
                } else {
                    // Not a board — remove if previously indexed
                    this.boards.delete(relPath);
                }
            } catch {
                // Skip unreadable files
            }
        }
    }
}

// ─── Singleton ────────────────────────────────────────────────────────

export const kanbanIndex = new KanbanIndex();
