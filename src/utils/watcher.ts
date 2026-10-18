import { readdir, stat, lstat } from "node:fs/promises";
import { join, relative } from "node:path";
import { getVaultRoot, invalidateReadCache } from "./vault.js";
import { logger } from "./logger.js";
import { knowledgeIndex } from "./knowledge-index.js";
import { searchIndex } from "./search-index.js";
import { invalidateGraphCache } from "./graph-cache.js";
import { vectorStore } from "./vector-store.js";

interface FileSnapshot {
    mtime: number;
    size: number;
}

export interface FileChange {
    path: string;
    type: "created" | "modified" | "deleted";
    timestamp: string;
}

/** Maximum pending changes before dropping oldest entries. */
const MAX_PENDING_CHANGES = 10_000;

class VaultWatcher {
    private snapshots: Map<string, FileSnapshot> = new Map();
    private pendingChanges: FileChange[] = [];
    private intervalId: ReturnType<typeof setInterval> | null = null;
    private pollingInterval: number;
    private running = false;
    private scanning = false;

    constructor() {
        const envInterval = parseInt(process.env.NOTES_WATCH_INTERVAL || "5000", 10);
        this.pollingInterval = envInterval > 0 ? envInterval : 5000;
    }

    /**
     * Take initial snapshot of all files in the vault.
     */
    async initialize(): Promise<void> {
        const vaultRoot = getVaultRoot();
        await this.scanDirectory(vaultRoot);
        logger.info("File watcher initialized", { trackedFiles: this.snapshots.size });
    }

    /**
     * Start periodic polling for changes.
     */
    start(): void {
        if (this.running || this.pollingInterval <= 0) return;
        this.running = true;

        this.intervalId = setInterval(async () => {
            try {
                await this.detectChanges();
            } catch (err) {
                logger.error("File watcher poll error", {
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }, this.pollingInterval);

        logger.info("File watcher started", { intervalMs: this.pollingInterval });
    }

    /**
     * Stop polling.
     */
    stop(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.running = false;
        logger.info("File watcher stopped");
    }

    /**
     * Get and clear pending changes.
     */
    getChanges(): FileChange[] {
        const changes = [...this.pendingChanges];
        this.pendingChanges = [];
        return changes;
    }

    /**
     * Get count of pending changes without clearing.
     */
    getPendingCount(): number {
        return this.pendingChanges.length;
    }

    /**
     * Get pending changes without clearing them.
     */
    peekChanges(): FileChange[] {
        return [...this.pendingChanges];
    }

    /**
     * Scan a directory recursively and record file snapshots.
     */
    private async scanDirectory(dir: string): Promise<void> {
        try {
            const entries = await readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (
                    entry.name === ".trash" ||
                    entry.name === ".versions" ||
                    entry.name === ".quill-sessions" ||
                    entry.name === "node_modules" ||
                    entry.name === ".git" ||
                    entry.name === ".embeddings"
                )
                    continue;

                const fullPath = join(dir, entry.name);
                // Symlink defense: never recurse into symbolic links
                const entryStat = await lstat(fullPath);
                if (entryStat.isSymbolicLink()) continue;

                if (entry.isDirectory()) {
                    await this.scanDirectory(fullPath);
                } else if (entry.isFile()) {
                    try {
                        const s = await stat(fullPath);
                        const relPath = relative(getVaultRoot(), fullPath).replace(/\\/g, "/");
                        this.snapshots.set(relPath, { mtime: s.mtimeMs, size: s.size });
                    } catch {
                        // Skip inaccessible files
                    }
                }
            }
        } catch {
            // Skip inaccessible directories
        }
    }

    /**
     * Detect changes by comparing current state with snapshots.
     * Uses a scan lock to prevent overlapping polling scans.
     */
    private async detectChanges(): Promise<void> {
        if (this.scanning) return; // Prevent overlapping scans
        this.scanning = true;

        try {
            await this.performScan();
        } finally {
            this.scanning = false;
        }
    }

    /**
     * Perform the actual scan and update snapshots.
     */
    private async performScan(): Promise<void> {
        const vaultRoot = getVaultRoot();
        const currentFiles = new Map<string, FileSnapshot>();
        const previousChangeCount = this.pendingChanges.length;

        // Scan current state
        await this.scanCurrentState(vaultRoot, currentFiles);

        const now = new Date().toISOString();

        // Check for new and modified files
        for (const [path, snapshot] of currentFiles) {
            const prev = this.snapshots.get(path);
            if (!prev) {
                this.pendingChanges.push({ path, type: "created", timestamp: now });
            } else if (prev.mtime !== snapshot.mtime || prev.size !== snapshot.size) {
                this.pendingChanges.push({ path, type: "modified", timestamp: now });
            }
        }

        // Check for deleted files
        for (const [path] of this.snapshots) {
            if (!currentFiles.has(path)) {
                this.pendingChanges.push({ path, type: "deleted", timestamp: now });
            }
        }

        // Update snapshots
        this.snapshots = currentFiles;
        if (this.pendingChanges.length > previousChangeCount) {
            knowledgeIndex.markDirty();
            searchIndex.markDirty();
            // Invalidate read cache and graph cache so external edits are visible
            // on next access. Internal writes already invalidate per-path, but this
            // catches edits from Obsidian, other agents, or manual file changes.
            invalidateReadCache();
            invalidateGraphCache();
            // Invalidate embeddings for changed markdown files
            for (const change of this.pendingChanges.slice(previousChangeCount)) {
                if (change.path.endsWith(".md") && !change.path.startsWith(".embeddings/")) {
                    vectorStore.invalidate(change.path).catch(() => {});
                }
            }
            logger.debug("Cache invalidation triggered by external file changes", {
                newChanges: this.pendingChanges.length - previousChangeCount,
            });
        }

        // Bound event accumulation: drop oldest changes if over limit
        if (this.pendingChanges.length > MAX_PENDING_CHANGES) {
            const dropped = this.pendingChanges.length - MAX_PENDING_CHANGES;
            this.pendingChanges = this.pendingChanges.slice(dropped);
            logger.warn("Watcher pending changes exceeded limit, dropped oldest", { dropped });
        }
    }

    /**
     * Scan current file state into the provided map.
     */
    private async scanCurrentState(dir: string, result: Map<string, FileSnapshot>): Promise<void> {
        try {
            const entries = await readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (
                    entry.name === ".trash" ||
                    entry.name === ".versions" ||
                    entry.name === ".quill-sessions" ||
                    entry.name === "node_modules" ||
                    entry.name === ".git" ||
                    entry.name === ".embeddings"
                )
                    continue;

                const fullPath = join(dir, entry.name);
                // Symlink defense: never recurse into symbolic links
                const entryStat = await lstat(fullPath);
                if (entryStat.isSymbolicLink()) continue;

                if (entry.isDirectory()) {
                    await this.scanCurrentState(fullPath, result);
                } else if (entry.isFile()) {
                    try {
                        const s = await stat(fullPath);
                        const relPath = relative(getVaultRoot(), fullPath).replace(/\\/g, "/");
                        result.set(relPath, { mtime: s.mtimeMs, size: s.size });
                    } catch {
                        // Skip inaccessible files
                    }
                }
            }
        } catch {
            // Skip inaccessible directories
        }
    }
}

// Singleton instance
export const vaultWatcher = new VaultWatcher();
