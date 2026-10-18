/**
 * Undo stack for file edits.
 * Keeps the last N versions of a file before each write, enabling rollback.
 *
 * LIMITATIONS:
 * - In-memory only: all undo history is lost on process restart.
 * - Not persisted to disk. No .undo/ directory or file-based storage.
 * - Not safe with concurrent writers: if two agents write to the same file
 *   simultaneously, the undo stack may not reflect the correct previous state.
 *   Use write-note or append-note (which push undo before writing) rather than
 *   raw file writes to minimize this risk.
 * - Undo restores the exact content string that was present before the write,
 *   including frontmatter and encoding. It does NOT restore file metadata
 *   (mtime, permissions, etc.).
 * - Maximum 10 undo levels per file, 100 total across all files.
 */

interface UndoEntry {
    path: string;
    content: string;
    timestamp: number;
    /** Description of the change that triggered this save */
    reason: string;
}

const MAX_UNDO_PER_FILE = 10;
const MAX_UNDO_TOTAL = 100;

const undoStack: UndoEntry[] = [];

/**
 * Save the current content of a file before modifying it.
 * Call this BEFORE writing new content to enable undo.
 */
export function pushUndo(path: string, content: string, reason: string): void {
    undoStack.push({ path, content, timestamp: Date.now(), reason });

    // Trim per-file history
    const fileEntries = undoStack.filter((e) => e.path === path);
    if (fileEntries.length > MAX_UNDO_PER_FILE) {
        const oldest = fileEntries[0];
        const idx = undoStack.indexOf(oldest);
        if (idx !== -1) undoStack.splice(idx, 1);
    }

    // Trim total stack
    while (undoStack.length > MAX_UNDO_TOTAL) {
        undoStack.shift();
    }
}

/**
 * Pop the most recent undo entry for a file.
 * Returns null if no undo is available.
 */
export function popUndo(path: string): UndoEntry | null {
    for (let i = undoStack.length - 1; i >= 0; i--) {
        if (undoStack[i].path === path) {
            return undoStack.splice(i, 1)[0];
        }
    }
    return null;
}

/**
 * Peek at the most recent undo entry without removing it.
 */
export function peekUndo(path: string): UndoEntry | null {
    for (let i = undoStack.length - 1; i >= 0; i--) {
        if (undoStack[i].path === path) {
            return undoStack[i];
        }
    }
    return null;
}

/**
 * Get undo history for a file (most recent first).
 */
export function getUndoHistory(path: string): { timestamp: number; reason: string; contentLength: number }[] {
    return undoStack
        .filter((e) => e.path === path)
        .reverse()
        .map((e) => ({
            timestamp: e.timestamp,
            reason: e.reason,
            contentLength: e.content.length,
        }));
}

/**
 * Get summary of the undo stack.
 */
export function getUndoStats(): { totalEntries: number; files: number; maxPerFile: number; maxTotal: number } {
    const files = new Set(undoStack.map((e) => e.path));
    return {
        totalEntries: undoStack.length,
        files: files.size,
        maxPerFile: MAX_UNDO_PER_FILE,
        maxTotal: MAX_UNDO_TOTAL,
    };
}

/**
 * Clear all undo history.
 */
export function clearUndo(): void {
    undoStack.length = 0;
}
