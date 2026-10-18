/**
 * Tests for the recurring-engine utility module.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initVault } from "../utils/vault.js";
import {
    parseRecurrencePattern,
    parsePatternString,
    hasRecurrence,
    computeNextDueDate,
    toDateStr,
    fromDateStr,
    todayStr,
    isOverdue,
    loadRecurrenceState,
    saveRecurrenceState,
    upsertStateEntry,
    removeStateEntry,
    findStateEntry,
    makeTaskId,
    countMissedOccurrences,
    buildRecurringTaskLine,
    type RecurrenceRule,
    type RecurrenceState,
    type RecurrenceStateFile,
} from "../utils/recurring-engine.js";

let testCounter = 0;
let TEST_VAULT = "";

describe("recurring-engine", () => {
    beforeEach(async () => {
        TEST_VAULT = join(process.cwd(), `test-vault-recurring-${process.pid}-${testCounter++}`);
        await rm(TEST_VAULT, { recursive: true, force: true });
        await mkdir(TEST_VAULT, { recursive: true });
        process.env.NOTES_VAULT_PATH = TEST_VAULT;
        initVault();
    });

    afterEach(async () => {
        delete process.env.NOTES_VAULT_PATH;
        try {
            await Promise.race([
                rm(TEST_VAULT, { recursive: true, force: true }),
                new Promise((_, reject) => setTimeout(() => reject(new Error("cleanup timeout")), 5000)),
            ]);
        } catch {
            // Best effort
        }
    }, 10000);

    // ─── Pattern Parsing ──────────────────────────────────────────────

    describe("parseRecurrencePattern", () => {
        it("parses daily pattern", () => {
            const rule = parseRecurrencePattern("Buy groceries \u{1F504} daily");
            expect(rule).not.toBeNull();
            expect(rule!.type).toBe("daily");
            expect(rule!.raw).toBe("daily");
        });

        it("parses weekly pattern", () => {
            const rule = parseRecurrencePattern("Team standup \u{1F504} weekly");
            expect(rule).not.toBeNull();
            expect(rule!.type).toBe("weekly");
        });

        it("parses weekly with specific days", () => {
            const rule = parseRecurrencePattern("Standup \u{1F504} weekly:mon,wed,fri");
            expect(rule).not.toBeNull();
            expect(rule!.type).toBe("weekly");
            expect(rule!.days).toEqual([1, 3, 5]); // Mon=1, Wed=3, Fri=5
        });

        it("parses weekly with full day names", () => {
            const rule = parseRecurrencePattern("Meeting \u{1F504} weekly:monday,friday");
            expect(rule).not.toBeNull();
            expect(rule!.days).toEqual([1, 5]);
        });

        it("parses monthly pattern", () => {
            const rule = parseRecurrencePattern("Pay rent \u{1F504} monthly");
            expect(rule).not.toBeNull();
            expect(rule!.type).toBe("monthly");
        });

        it("parses monthly with specific day", () => {
            const rule = parseRecurrencePattern("Pay rent \u{1F504} monthly:15");
            expect(rule).not.toBeNull();
            expect(rule!.type).toBe("monthly");
            expect(rule!.dayOfMonth).toBe(15);
        });

        it("rejects monthly with invalid day (>31)", () => {
            const rule = parseRecurrencePattern("Task \u{1F504} monthly:32");
            expect(rule).toBeNull();
        });

        it("rejects monthly with invalid day (0)", () => {
            const rule = parseRecurrencePattern("Task \u{1F504} monthly:0");
            expect(rule).toBeNull();
        });

        it("parses yearly pattern", () => {
            const rule = parseRecurrencePattern("Birthday \u{1F504} yearly");
            expect(rule).not.toBeNull();
            expect(rule!.type).toBe("yearly");
        });

        it("parses custom interval (every N days)", () => {
            const rule = parseRecurrencePattern("Water plants \u{1F504} every:3:d");
            expect(rule).not.toBeNull();
            expect(rule!.type).toBe("custom");
            expect(rule!.interval).toBe(3);
            expect(rule!.unit).toBe("d");
        });

        it("parses custom interval (every N weeks)", () => {
            const rule = parseRecurrencePattern("Sprint review \u{1F504} every:2:w");
            expect(rule).not.toBeNull();
            expect(rule!.type).toBe("custom");
            expect(rule!.interval).toBe(2);
            expect(rule!.unit).toBe("w");
        });

        it("parses custom interval (every N months)", () => {
            const rule = parseRecurrencePattern("Quarterly review \u{1F504} every:3:m");
            expect(rule).not.toBeNull();
            expect(rule!.type).toBe("custom");
            expect(rule!.interval).toBe(3);
            expect(rule!.unit).toBe("m");
        });

        it("parses custom interval (every N years)", () => {
            const rule = parseRecurrencePattern("Census \u{1F504} every:10:y");
            expect(rule).not.toBeNull();
            expect(rule!.type).toBe("custom");
            expect(rule!.interval).toBe(10);
            expect(rule!.unit).toBe("y");
        });

        it("returns null for no recurrence marker", () => {
            expect(parseRecurrencePattern("Buy groceries")).toBeNull();
        });

        it("returns null for invalid pattern", () => {
            expect(parseRecurrencePattern("Task \u{1F504} invalid")).toBeNull();
        });

        it("returns null for custom with zero interval", () => {
            expect(parseRecurrencePattern("Task \u{1F504} every:0:d")).toBeNull();
        });

        it("returns null for weekly with invalid day name", () => {
            expect(parseRecurrencePattern("Task \u{1F504} weekly:foo")).toBeNull();
        });
    });

    describe("hasRecurrence", () => {
        it("returns true for lines with recurrence marker", () => {
            expect(hasRecurrence("Task \u{1F504} daily")).toBe(true);
        });

        it("returns false for lines without marker", () => {
            expect(hasRecurrence("Just a task")).toBe(false);
        });
    });

    describe("parsePatternString", () => {
        it("is case-insensitive", () => {
            const rule = parsePatternString("DAILY");
            expect(rule).not.toBeNull();
            expect(rule!.type).toBe("daily");
        });

        it("handles mixed case", () => {
            const rule = parsePatternString("Weekly:Mon,Wed");
            expect(rule).not.toBeNull();
            expect(rule!.days).toEqual([1, 3]);
        });
    });

    // ─── Next Date Computation ────────────────────────────────────────

    describe("computeNextDueDate", () => {
        it("daily: next day", () => {
            const base = fromDateStr("2026-10-17");
            const rule: RecurrenceRule = { raw: "daily", type: "daily" };
            expect(computeNextDueDate(rule, base)).toBe("2026-10-18");
        });

        it("daily: crosses month boundary", () => {
            const base = fromDateStr("2026-10-31");
            const rule: RecurrenceRule = { raw: "daily", type: "daily" };
            expect(computeNextDueDate(rule, base)).toBe("2026-11-01");
        });

        it("weekly: 7 days later", () => {
            const base = fromDateStr("2026-10-17"); // Saturday
            const rule: RecurrenceRule = { raw: "weekly", type: "weekly" };
            expect(computeNextDueDate(rule, base)).toBe("2026-10-24");
        });

        it("weekly with days: finds next matching weekday", () => {
            // 2026-10-17 is a Saturday (day 6)
            const base = fromDateStr("2026-10-17");
            const rule: RecurrenceRule = { raw: "weekly:mon,wed,fri", type: "weekly", days: [1, 3, 5] };
            // Next Monday is 2026-10-19
            expect(computeNextDueDate(rule, base)).toBe("2026-10-19");
        });

        it("weekly with days: wraps to next week", () => {
            // 2026-10-19 is a Monday
            const base = fromDateStr("2026-10-19");
            const rule: RecurrenceRule = { raw: "weekly:mon", type: "weekly", days: [1] };
            // Next Monday is 2026-10-26
            expect(computeNextDueDate(rule, base)).toBe("2026-10-26");
        });

        it("monthly: same day next month", () => {
            const base = fromDateStr("2026-10-15");
            const rule: RecurrenceRule = { raw: "monthly", type: "monthly" };
            expect(computeNextDueDate(rule, base)).toBe("2026-11-15");
        });

        it("monthly with specific day: clamps to month length", () => {
            // January has 31 days, target day 31
            const base = fromDateStr("2026-01-31");
            const rule: RecurrenceRule = { raw: "monthly:31", type: "monthly", dayOfMonth: 31 };
            // February has 28 days in 2026 -> clamped to 28
            expect(computeNextDueDate(rule, base)).toBe("2026-02-28");
        });

        it("monthly: handles leap year February", () => {
            const base = fromDateStr("2024-01-31"); // 2024 is a leap year
            const rule: RecurrenceRule = { raw: "monthly:31", type: "monthly", dayOfMonth: 31 };
            // February 2024 has 29 days
            expect(computeNextDueDate(rule, base)).toBe("2024-02-29");
        });

        it("yearly: same date next year", () => {
            const base = fromDateStr("2026-06-15");
            const rule: RecurrenceRule = { raw: "yearly", type: "yearly" };
            expect(computeNextDueDate(rule, base)).toBe("2027-06-15");
        });

        it("yearly: handles leap year (Feb 29 -> Feb 28)", () => {
            const base = fromDateStr("2024-02-29");
            const rule: RecurrenceRule = { raw: "yearly", type: "yearly" };
            // 2025 is not a leap year -> Feb 28
            expect(computeNextDueDate(rule, base)).toBe("2025-02-28");
        });

        it("custom every:N:d", () => {
            const base = fromDateStr("2026-10-17");
            const rule: RecurrenceRule = { raw: "every:3:d", type: "custom", interval: 3, unit: "d" };
            expect(computeNextDueDate(rule, base)).toBe("2026-10-20");
        });

        it("custom every:N:w", () => {
            const base = fromDateStr("2026-10-17");
            const rule: RecurrenceRule = { raw: "every:2:w", type: "custom", interval: 2, unit: "w" };
            expect(computeNextDueDate(rule, base)).toBe("2026-10-31");
        });

        it("custom every:N:m crosses month boundary", () => {
            const base = fromDateStr("2026-01-31");
            const rule: RecurrenceRule = { raw: "every:1:m", type: "custom", interval: 1, unit: "m" };
            // Feb 2026 has 28 days -> clamped to 28
            expect(computeNextDueDate(rule, base)).toBe("2026-02-28");
        });

        it("custom every:N:y handles leap year", () => {
            const base = fromDateStr("2024-02-29");
            const rule: RecurrenceRule = { raw: "every:4:y", type: "custom", interval: 4, unit: "y" };
            // 2028 is a leap year, so Feb 29 exists
            expect(computeNextDueDate(rule, base)).toBe("2028-02-29");
        });

        it("custom every:N:y non-leap year clamps to Feb 28", () => {
            const base = fromDateStr("2024-02-29");
            const rule: RecurrenceRule = { raw: "every:1:y", type: "custom", interval: 1, unit: "y" };
            // 2025 is not a leap year -> Feb 28
            expect(computeNextDueDate(rule, base)).toBe("2025-02-28");
        });
    });

    // ─── Date Helpers ─────────────────────────────────────────────────

    describe("date helpers", () => {
        it("toDateStr formats correctly", () => {
            const date = new Date(Date.UTC(2026, 9, 17)); // Oct 17, 2026
            expect(toDateStr(date)).toBe("2026-10-17");
        });

        it("fromDateStr parses correctly", () => {
            const date = fromDateStr("2026-10-17");
            expect(date.getUTCFullYear()).toBe(2026);
            expect(date.getUTCMonth()).toBe(9); // 0-indexed
            expect(date.getUTCDate()).toBe(17);
        });

        it("todayStr returns current date", () => {
            const today = todayStr();
            expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        });

        it("isOverdue detects past dates", () => {
            expect(isOverdue("2020-01-01")).toBe(true);
        });

        it("isOverdue returns false for future dates", () => {
            expect(isOverdue("2099-12-31")).toBe(false);
        });
    });

    // ─── State Persistence ────────────────────────────────────────────

    describe("state persistence", () => {
        it("loads empty state when file doesn't exist", async () => {
            const state = await loadRecurrenceState();
            expect(state.version).toBe(1);
            expect(state.entries).toEqual([]);
        });

        it("saves and loads state", async () => {
            const state: RecurrenceStateFile = {
                version: 1,
                entries: [
                    {
                        taskId: "tasks.md:1",
                        lastCompleted: "2026-10-17T00:00:00.000Z",
                        nextDue: "2026-10-18",
                        paused: false,
                        skipCount: 0,
                        pattern: "daily",
                        description: "Test task",
                        filePath: "tasks.md",
                        lineNum: 1,
                    },
                ],
            };
            await saveRecurrenceState(state);

            const loaded = await loadRecurrenceState();
            expect(loaded.entries).toHaveLength(1);
            expect(loaded.entries[0].taskId).toBe("tasks.md:1");
            expect(loaded.entries[0].pattern).toBe("daily");
        });

        it("upsertStateEntry updates existing entry", async () => {
            const state: RecurrenceStateFile = { version: 1, entries: [] };
            const entry: RecurrenceState = {
                taskId: "tasks.md:1",
                lastCompleted: null,
                nextDue: "2026-10-18",
                paused: false,
                skipCount: 0,
                pattern: "daily",
                description: "Test",
                filePath: "tasks.md",
                lineNum: 1,
            };

            upsertStateEntry(state, entry);
            expect(state.entries).toHaveLength(1);

            entry.nextDue = "2026-10-19";
            upsertStateEntry(state, entry);
            expect(state.entries).toHaveLength(1);
            expect(state.entries[0].nextDue).toBe("2026-10-19");
        });

        it("removeStateEntry removes entry", () => {
            const state: RecurrenceStateFile = {
                version: 1,
                entries: [
                    {
                        taskId: "tasks.md:1",
                        lastCompleted: null,
                        nextDue: "2026-10-18",
                        paused: false,
                        skipCount: 0,
                        pattern: "daily",
                        description: "Test",
                        filePath: "tasks.md",
                        lineNum: 1,
                    },
                ],
            };

            expect(removeStateEntry(state, "tasks.md:1")).toBe(true);
            expect(state.entries).toHaveLength(0);
        });

        it("removeStateEntry returns false for missing entry", () => {
            const state: RecurrenceStateFile = { version: 1, entries: [] };
            expect(removeStateEntry(state, "nonexistent")).toBe(false);
        });

        it("findStateEntry finds by taskId", () => {
            const state: RecurrenceStateFile = {
                version: 1,
                entries: [
                    {
                        taskId: "tasks.md:5",
                        lastCompleted: null,
                        nextDue: "2026-10-18",
                        paused: false,
                        skipCount: 0,
                        pattern: "weekly",
                        description: "Test",
                        filePath: "tasks.md",
                        lineNum: 5,
                    },
                ],
            };

            const found = findStateEntry(state, "tasks.md:5");
            expect(found).toBeDefined();
            expect(found!.pattern).toBe("weekly");
        });

        it("handles corrupted state file gracefully", async () => {
            const statePath = join(TEST_VAULT, ".quill-recurrence-state.json");
            await writeFile(statePath, "not valid json", "utf-8");

            const state = await loadRecurrenceState();
            expect(state.version).toBe(1);
            expect(state.entries).toEqual([]);
        });

        it("handles invalid version gracefully", async () => {
            const statePath = join(TEST_VAULT, ".quill-recurrence-state.json");
            await writeFile(statePath, JSON.stringify({ version: 99, entries: [] }), "utf-8");

            const state = await loadRecurrenceState();
            expect(state.version).toBe(1);
            expect(state.entries).toEqual([]);
        });
    });

    // ─── Task ID ──────────────────────────────────────────────────────

    describe("makeTaskId", () => {
        it("creates stable ID from path and line", () => {
            expect(makeTaskId("tasks.md", 5)).toBe("tasks.md:5");
        });

        it("handles nested paths", () => {
            expect(makeTaskId("projects/work/tasks.md", 12)).toBe("projects/work/tasks.md:12");
        });
    });

    // ─── Missed Occurrences ───────────────────────────────────────────

    describe("countMissedOccurrences", () => {
        it("returns 0 when never completed", () => {
            const rule: RecurrenceRule = { raw: "daily", type: "daily" };
            expect(countMissedOccurrences(rule, null, "2026-10-20")).toBe(0);
        });

        it("counts missed daily occurrences", () => {
            const rule: RecurrenceRule = { raw: "daily", type: "daily" };
            // Last completed on Oct 17, today is Oct 20 -> missed Oct 18, Oct 19
            expect(countMissedOccurrences(rule, "2026-10-17", "2026-10-20")).toBe(2);
        });

        it("counts missed weekly occurrences", () => {
            const rule: RecurrenceRule = { raw: "weekly", type: "weekly" };
            // Last completed Oct 3, today is Oct 24 -> missed Oct 10, Oct 17
            expect(countMissedOccurrences(rule, "2026-10-03", "2026-10-24")).toBe(2);
        });

        it("returns 0 when no occurrences missed", () => {
            const rule: RecurrenceRule = { raw: "daily", type: "daily" };
            expect(countMissedOccurrences(rule, "2026-10-19", "2026-10-20")).toBe(0);
        });
    });

    // ─── Build Task Line ──────────────────────────────────────────────

    describe("buildRecurringTaskLine", () => {
        it("builds line with pattern only", () => {
            const line = buildRecurringTaskLine("Buy groceries", "daily");
            expect(line).toBe("- [ ] Buy groceries \u{1F504} daily");
        });

        it("builds line with pattern and due date", () => {
            const line = buildRecurringTaskLine("Pay rent", "monthly:1", "2026-11-01");
            expect(line).toBe("- [ ] Pay rent \u{1F504} monthly:1 \u{1F4C5} 2026-11-01");
        });

        it("builds line without due date when null", () => {
            const line = buildRecurringTaskLine("Task", "weekly", null);
            expect(line).toBe("- [ ] Task \u{1F504} weekly");
        });
    });
});
