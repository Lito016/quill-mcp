/**
 * Unit tests for the undo stack.
 * Covers push/pop/peek/history/stats/clear, per-file limits, total limits, and trimming.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { pushUndo, popUndo, peekUndo, getUndoHistory, getUndoStats, clearUndo } from "./undo-stack.js";

describe("UndoStack", () => {
    beforeEach(() => {
        clearUndo();
    });

    // ── pushUndo ──────────────────────────────────────────────────────

    describe("pushUndo", () => {
        it("adds an entry to the stack", () => {
            pushUndo("notes/a.md", "content-a", "initial write");
            const stats = getUndoStats();
            expect(stats.totalEntries).toBe(1);
            expect(stats.files).toBe(1);
        });

        it("stores correct path, content, and reason", () => {
            pushUndo("notes/a.md", "hello world", "test reason");
            const entry = peekUndo("notes/a.md");
            expect(entry).not.toBeNull();
            expect(entry!.path).toBe("notes/a.md");
            expect(entry!.content).toBe("hello world");
            expect(entry!.reason).toBe("test reason");
            expect(entry!.timestamp).toBeTypeOf("number");
            expect(entry!.timestamp).toBeGreaterThan(0);
        });

        it("supports multiple files", () => {
            pushUndo("notes/a.md", "a", "write a");
            pushUndo("notes/b.md", "b", "write b");
            pushUndo("notes/c.md", "c", "write c");
            const stats = getUndoStats();
            expect(stats.totalEntries).toBe(3);
            expect(stats.files).toBe(3);
        });

        it("supports multiple entries for the same file", () => {
            pushUndo("notes/a.md", "v1", "write 1");
            pushUndo("notes/a.md", "v2", "write 2");
            pushUndo("notes/a.md", "v3", "write 3");
            const stats = getUndoStats();
            expect(stats.totalEntries).toBe(3);
            expect(stats.files).toBe(1);
        });
    });

    // ── popUndo ───────────────────────────────────────────────────────

    describe("popUndo", () => {
        it("returns the most recent entry for a file", () => {
            pushUndo("notes/a.md", "v1", "first");
            pushUndo("notes/a.md", "v2", "second");
            const entry = popUndo("notes/a.md");
            expect(entry).not.toBeNull();
            expect(entry!.content).toBe("v2");
            expect(entry!.reason).toBe("second");
        });

        it("removes the entry from the stack", () => {
            pushUndo("notes/a.md", "v1", "first");
            popUndo("notes/a.md");
            expect(peekUndo("notes/a.md")).toBeNull();
        });

        it("returns the next-most-recent entry after pop", () => {
            pushUndo("notes/a.md", "v1", "first");
            pushUndo("notes/a.md", "v2", "second");
            popUndo("notes/a.md");
            const entry = peekUndo("notes/a.md");
            expect(entry!.content).toBe("v1");
        });

        it("returns null for unknown file", () => {
            expect(popUndo("nonexistent.md")).toBeNull();
        });

        it("returns null on empty stack", () => {
            expect(popUndo("any.md")).toBeNull();
        });

        it("only pops for the specified file, not others", () => {
            pushUndo("notes/a.md", "a-content", "write a");
            pushUndo("notes/b.md", "b-content", "write b");
            const popped = popUndo("notes/a.md");
            expect(popped!.content).toBe("a-content");
            // b should still be there
            expect(peekUndo("notes/b.md")!.content).toBe("b-content");
        });

        it("pops the most recent entry across interleaved files", () => {
            pushUndo("notes/a.md", "a1", "a first");
            pushUndo("notes/b.md", "b1", "b first");
            pushUndo("notes/a.md", "a2", "a second");
            // Most recent for a.md is a2
            const popped = popUndo("notes/a.md");
            expect(popped!.content).toBe("a2");
        });
    });

    // ── peekUndo ──────────────────────────────────────────────────────

    describe("peekUndo", () => {
        it("returns the most recent entry without removing it", () => {
            pushUndo("notes/a.md", "v1", "first");
            pushUndo("notes/a.md", "v2", "second");
            const peeked = peekUndo("notes/a.md");
            expect(peeked).not.toBeNull();
            expect(peeked!.content).toBe("v2");
            // Still there after peek
            expect(peekUndo("notes/a.md")!.content).toBe("v2");
        });

        it("returns null for unknown file", () => {
            expect(peekUndo("nonexistent.md")).toBeNull();
        });

        it("returns null on empty stack", () => {
            expect(peekUndo("any.md")).toBeNull();
        });
    });

    // ── getUndoHistory ────────────────────────────────────────────────

    describe("getUndoHistory", () => {
        it("returns history in most-recent-first order", () => {
            pushUndo("notes/a.md", "v1", "first");
            pushUndo("notes/a.md", "v2", "second");
            pushUndo("notes/a.md", "v3", "third");
            const history = getUndoHistory("notes/a.md");
            expect(history).toHaveLength(3);
            expect(history[0].reason).toBe("third");
            expect(history[1].reason).toBe("second");
            expect(history[2].reason).toBe("first");
        });

        it("includes contentLength for each entry", () => {
            pushUndo("notes/a.md", "hello", "write");
            const history = getUndoHistory("notes/a.md");
            expect(history[0].contentLength).toBe(5);
        });

        it("includes timestamp and reason", () => {
            pushUndo("notes/a.md", "content", "my reason");
            const history = getUndoHistory("notes/a.md");
            expect(history[0].timestamp).toBeTypeOf("number");
            expect(history[0].reason).toBe("my reason");
        });

        it("returns empty array for unknown file", () => {
            expect(getUndoHistory("nonexistent.md")).toEqual([]);
        });

        it("returns empty array on empty stack", () => {
            expect(getUndoHistory("any.md")).toEqual([]);
        });

        it("only returns history for the specified file", () => {
            pushUndo("notes/a.md", "a", "write a");
            pushUndo("notes/b.md", "b", "write b");
            const history = getUndoHistory("notes/a.md");
            expect(history).toHaveLength(1);
            expect(history[0].reason).toBe("write a");
        });
    });

    // ── getUndoStats ──────────────────────────────────────────────────

    describe("getUndoStats", () => {
        it("returns correct stats on empty stack", () => {
            const stats = getUndoStats();
            expect(stats.totalEntries).toBe(0);
            expect(stats.files).toBe(0);
            expect(stats.maxPerFile).toBe(10);
            expect(stats.maxTotal).toBe(100);
        });

        it("counts total entries correctly", () => {
            pushUndo("a.md", "a", "r");
            pushUndo("b.md", "b", "r");
            pushUndo("c.md", "c", "r");
            expect(getUndoStats().totalEntries).toBe(3);
        });

        it("counts unique files correctly", () => {
            pushUndo("a.md", "v1", "r");
            pushUndo("a.md", "v2", "r");
            pushUndo("b.md", "v1", "r");
            expect(getUndoStats().files).toBe(2);
        });

        it("exposes maxPerFile and maxTotal constants", () => {
            const stats = getUndoStats();
            expect(stats.maxPerFile).toBe(10);
            expect(stats.maxTotal).toBe(100);
        });
    });

    // ── clearUndo ─────────────────────────────────────────────────────

    describe("clearUndo", () => {
        it("clears all entries", () => {
            pushUndo("a.md", "a", "r");
            pushUndo("b.md", "b", "r");
            clearUndo();
            expect(getUndoStats().totalEntries).toBe(0);
            expect(getUndoStats().files).toBe(0);
        });

        it("makes pop/peek return null for previously tracked files", () => {
            pushUndo("a.md", "content", "reason");
            clearUndo();
            expect(popUndo("a.md")).toBeNull();
            expect(peekUndo("a.md")).toBeNull();
        });

        it("makes history return empty array", () => {
            pushUndo("a.md", "content", "reason");
            clearUndo();
            expect(getUndoHistory("a.md")).toEqual([]);
        });

        it("is safe to call on already-empty stack", () => {
            clearUndo();
            clearUndo();
            expect(getUndoStats().totalEntries).toBe(0);
        });
    });

    // ── Per-file limit (MAX_UNDO_PER_FILE = 10) ──────────────────────

    describe("per-file limit (MAX_UNDO_PER_FILE = 10)", () => {
        it("trims oldest entry when exceeding 10 per file", () => {
            for (let i = 0; i < 11; i++) {
                pushUndo("notes/a.md", `version-${i}`, `write-${i}`);
            }
            const history = getUndoHistory("notes/a.md");
            expect(history).toHaveLength(10);
            // Most recent should be version-10
            expect(history[0].reason).toBe("write-10");
            // Oldest remaining should be version-1 (version-0 was trimmed)
            expect(history[9].reason).toBe("write-1");
        });

        it("does not trim when at exactly 10", () => {
            for (let i = 0; i < 10; i++) {
                pushUndo("notes/a.md", `version-${i}`, `write-${i}`);
            }
            const history = getUndoHistory("notes/a.md");
            expect(history).toHaveLength(10);
            expect(history[9].reason).toBe("write-0");
        });

        it("per-file trimming does not affect other files", () => {
            // Push 10 entries for file b
            for (let i = 0; i < 10; i++) {
                pushUndo("notes/b.md", `b-version-${i}`, `b-write-${i}`);
            }
            // Push 11 entries for file a (triggers trim)
            for (let i = 0; i < 11; i++) {
                pushUndo("notes/a.md", `a-version-${i}`, `a-write-${i}`);
            }
            // File b should still have all 10 entries
            expect(getUndoHistory("notes/b.md")).toHaveLength(10);
            // File a should have 10 entries (trimmed 1)
            expect(getUndoHistory("notes/a.md")).toHaveLength(10);
        });
    });

    // ── Total limit (MAX_UNDO_TOTAL = 100) ────────────────────────────

    describe("total limit (MAX_UNDO_TOTAL = 100)", () => {
        it("trims oldest entries globally when exceeding 100 total", () => {
            // Push 101 entries across different files (10 per file max)
            // 10 files * 10 entries = 100, then 1 more triggers trim
            for (let f = 0; f < 10; f++) {
                for (let i = 0; i < 10; i++) {
                    pushUndo(`notes/file-${f}.md`, `v${i}`, `w${i}`);
                }
            }
            expect(getUndoStats().totalEntries).toBe(100);

            // Adding one more should trigger global trim
            pushUndo("notes/extra.md", "extra", "extra-write");
            expect(getUndoStats().totalEntries).toBe(100);
            // The extra file should have its entry
            expect(peekUndo("notes/extra.md")).not.toBeNull();
        });

        it("removes from the front of the stack (oldest first)", () => {
            // Fill up with 100 entries across files
            for (let f = 0; f < 10; f++) {
                for (let i = 0; i < 10; i++) {
                    pushUndo(`notes/file-${f}.md`, `content-${f}-${i}`, `reason-${f}-${i}`);
                }
            }
            // The very first entry was file-0, version-0
            // After adding one more, file-0's oldest should be gone
            pushUndo("notes/overflow.md", "overflow", "overflow-reason");
            // file-0 should have lost its oldest entry
            const file0History = getUndoHistory("notes/file-0.md");
            expect(file0History).toHaveLength(9);
            expect(file0History[0].reason).toBe("reason-0-9"); // most recent of file-0
        });
    });

    // ── Edge cases ────────────────────────────────────────────────────

    describe("edge cases", () => {
        it("handles empty content string", () => {
            pushUndo("notes/empty.md", "", "create empty");
            const entry = peekUndo("notes/empty.md");
            expect(entry!.content).toBe("");
            const history = getUndoHistory("notes/empty.md");
            expect(history[0].contentLength).toBe(0);
        });

        it("handles very long content", () => {
            const longContent = "x".repeat(100_000);
            pushUndo("notes/long.md", longContent, "big write");
            const entry = peekUndo("notes/long.md");
            expect(entry!.content).toBe(longContent);
        });

        it("handles unicode content", () => {
            pushUndo("notes/unicode.md", "Hello \u{1F600} \u4F60\u597D \u00E9\u00E8\u00EA", "unicode write");
            const entry = peekUndo("notes/unicode.md");
            expect(entry!.content).toBe("Hello \u{1F600} \u4F60\u597D \u00E9\u00E8\u00EA");
        });

        it("handles paths with special characters", () => {
            pushUndo("notes/sub dir/file (copy).md", "content", "write");
            const entry = peekUndo("notes/sub dir/file (copy).md");
            expect(entry).not.toBeNull();
        });

        it("pop on one file does not affect other files' stacks", () => {
            pushUndo("a.md", "a1", "r");
            pushUndo("a.md", "a2", "r");
            pushUndo("b.md", "b1", "r");
            pushUndo("b.md", "b2", "r");

            popUndo("a.md");
            // b should still have 2 entries
            expect(getUndoHistory("b.md")).toHaveLength(2);
            // a should have 1
            expect(getUndoHistory("a.md")).toHaveLength(1);
        });

        it("timestamp is close to Date.now()", () => {
            const before = Date.now();
            pushUndo("notes/a.md", "content", "reason");
            const after = Date.now();
            const entry = peekUndo("notes/a.md");
            expect(entry!.timestamp).toBeGreaterThanOrEqual(before);
            expect(entry!.timestamp).toBeLessThanOrEqual(after);
        });
    });
});
