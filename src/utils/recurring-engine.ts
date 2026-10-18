/**
 * Recurring task engine: parses recurrence patterns, computes next due dates,
 * and manages recurrence state persistence.
 *
 * Supported patterns:
 *   daily                    - every day
 *   weekly                   - every 7 days
 *   weekly:mon,wed,fri       - specific weekdays
 *   monthly                  - same day each month
 *   monthly:15               - specific day of month
 *   yearly                   - same date each year
 *   every:N:d|w|m|y          - custom interval (N days/weeks/months/years)
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { getVaultRoot } from "./vault.js";
import { logger } from "./logger.js";

// ─── Types ────────────────────────────────────────────────────────────

export type RecurrencePatternType = "daily" | "weekly" | "monthly" | "yearly" | "custom";

export interface RecurrenceRule {
    /** The raw pattern string from the task line (e.g. "weekly:mon,wed,fri"). */
    raw: string;
    /** Parsed pattern type. */
    type: RecurrencePatternType;
    /** For weekly: specific days (0=Sun..6=Sat). For custom with 'w': unused. */
    days?: number[];
    /** For monthly: specific day of month. */
    dayOfMonth?: number;
    /** For custom: interval amount. */
    interval?: number;
    /** For custom: unit (d=days, w=weeks, m=months, y=years). */
    unit?: "d" | "w" | "m" | "y";
}

export interface RecurrenceState {
    /** Unique task identifier (file:lineNum or generated hash). */
    taskId: string;
    /** ISO 8601 timestamp of last completion. */
    lastCompleted: string | null;
    /** ISO 8601 timestamp of next due date. */
    nextDue: string;
    /** Whether this recurrence is paused. */
    paused: boolean;
    /** Number of times this occurrence has been skipped. */
    skipCount: number;
    /** The recurrence pattern string. */
    pattern: string;
    /** The original task description (without recurrence metadata). */
    description: string;
    /** File path (vault-relative) containing this task. */
    filePath: string;
    /** Line number in the file. */
    lineNum: number;
}

export interface RecurrenceStateFile {
    version: 1;
    entries: RecurrenceState[];
}

// ─── Constants ────────────────────────────────────────────────────────

/** Recurrence emoji marker in task lines. */
const RECURRENCE_EMOJI = "\u{1F504}"; // 🔄

/** Path to the recurrence state file, relative to vault root. */
const STATE_FILE = ".quill-recurrence-state.json";

/** Day name to weekday number mapping (0=Sunday). */
const DAY_MAP: Record<string, number> = {
    sun: 0, sunday: 0,
    mon: 1, monday: 1,
    tue: 2, tuesday: 2,
    wed: 3, wednesday: 3,
    thu: 4, thursday: 4,
    fri: 5, friday: 5,
    sat: 6, saturday: 6,
};

// ─── Regex ────────────────────────────────────────────────────────────

/** Matches the recurrence emoji followed by a pattern. */
const RECURRENCE_RE = new RegExp(`${RECURRENCE_EMOJI}\\s*(\\S+)`, "u");

// ─── Parsing ──────────────────────────────────────────────────────────

/**
 * Extract the recurrence pattern from a task line, if present.
 * Returns null if no recurrence marker is found.
 */
export function parseRecurrencePattern(line: string): RecurrenceRule | null {
    const match = line.match(RECURRENCE_RE);
    if (!match) return null;

    const raw = match[1];
    return parsePatternString(raw);
}

/**
 * Parse a pattern string into a RecurrenceRule.
 */
export function parsePatternString(raw: string): RecurrenceRule | null {
    const lower = raw.toLowerCase();

    // daily
    if (lower === "daily") {
        return { raw, type: "daily" };
    }

    // weekly or weekly:days
    if (lower === "weekly") {
        return { raw, type: "weekly" };
    }
    if (lower.startsWith("weekly:")) {
        const daysPart = lower.slice("weekly:".length);
        const days = parseDayNames(daysPart);
        if (days === null || days.length === 0) return null;
        return { raw, type: "weekly", days: days.sort((a, b) => a - b) };
    }

    // monthly or monthly:day
    if (lower === "monthly") {
        return { raw, type: "monthly" };
    }
    if (lower.startsWith("monthly:")) {
        const dayPart = parseInt(lower.slice("monthly:".length), 10);
        if (isNaN(dayPart) || dayPart < 1 || dayPart > 31) return null;
        return { raw, type: "monthly", dayOfMonth: dayPart };
    }

    // yearly
    if (lower === "yearly") {
        return { raw, type: "yearly" };
    }

    // every:N:unit
    const customMatch = lower.match(/^every:(\d+):([dwmy])$/);
    if (customMatch) {
        const interval = parseInt(customMatch[1], 10);
        const unit = customMatch[2] as "d" | "w" | "m" | "y";
        if (interval < 1) return null;
        return { raw, type: "custom", interval, unit };
    }

    return null;
}

/**
 * Parse comma-separated day names into weekday numbers.
 */
function parseDayNames(input: string): number[] | null {
    const parts = input.split(",").map((s) => s.trim());
    const days: number[] = [];
    for (const part of parts) {
        const dayNum = DAY_MAP[part];
        if (dayNum === undefined) return null;
        if (!days.includes(dayNum)) {
            days.push(dayNum);
        }
    }
    return days;
}

/**
 * Check if a task line contains a recurrence pattern.
 */
export function hasRecurrence(line: string): boolean {
    return RECURRENCE_RE.test(line);
}

/**
 * Extract the recurrence emoji + pattern string from a task line.
 * Returns the full match text (e.g. "🔄 weekly:mon,wed,fri") or null.
 */
export function extractRecurrenceText(line: string): string | null {
    const match = line.match(RECURRENCE_RE);
    return match ? match[0] : null;
}

// ─── Next Date Computation ────────────────────────────────────────────

/**
 * Compute the next due date after a given reference date, based on the recurrence rule.
 *
 * @param rule - The parsed recurrence rule.
 * @param afterDate - The date to compute the next occurrence after (typically today or last completion).
 * @returns ISO 8601 date string (YYYY-MM-DD) of the next due date.
 */
export function computeNextDueDate(rule: RecurrenceRule, afterDate: Date): string {
    const base = new Date(afterDate);
    // Normalize to start of day (UTC)
    base.setUTCHours(0, 0, 0, 0);

    switch (rule.type) {
        case "daily": {
            const next = new Date(base);
            next.setUTCDate(next.getUTCDate() + 1);
            return toDateStr(next);
        }

        case "weekly": {
            if (!rule.days || rule.days.length === 0) {
                // Simple weekly: every 7 days from base
                const next = new Date(base);
                next.setUTCDate(next.getUTCDate() + 7);
                return toDateStr(next);
            }
            // Specific days: find the next matching weekday
            return findNextWeekday(base, rule.days);
        }

        case "monthly": {
            const targetDay = rule.dayOfMonth ?? base.getUTCDate();
            return findNextMonthlyDate(base, targetDay);
        }

        case "yearly": {
            const next = new Date(Date.UTC(base.getUTCFullYear() + 1, base.getUTCMonth(), base.getUTCDate()));
            // Handle Feb 29 -> Feb 28 in non-leap years
            if (next.getUTCMonth() !== base.getUTCMonth()) {
                next.setUTCDate(0); // Last day of previous month (Feb 28)
            }
            return toDateStr(next);
        }

        case "custom": {
            return computeCustomInterval(base, rule.interval!, rule.unit!);
        }

        default:
            return toDateStr(base);
    }
}

/**
 * Find the next occurrence of specific weekdays after the base date.
 */
function findNextWeekday(base: Date, targetDays: number[]): string {
    const candidate = new Date(base);
    // Search up to 8 days ahead to ensure we find a match
    for (let i = 1; i <= 8; i++) {
        candidate.setUTCDate(candidate.getUTCDate() + 1);
        if (targetDays.includes(candidate.getUTCDay())) {
            return toDateStr(candidate);
        }
    }
    // Fallback (should never reach here with valid days)
    return toDateStr(new Date(base.getTime() + 7 * 86400000));
}

/**
 * Find the next monthly occurrence on the target day.
 * Handles month boundaries (e.g., day 31 in a 30-day month -> last day).
 */
function findNextMonthlyDate(base: Date, targetDay: number): string {
    // Try same month first (must be after base)
    const sameMonth = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1));
    const actualDay = clampDayToMonth(sameMonth.getUTCFullYear(), sameMonth.getUTCMonth(), targetDay);
    sameMonth.setUTCDate(actualDay);

    if (sameMonth.getTime() > base.getTime()) {
        return toDateStr(sameMonth);
    }

    // Next month
    const nextMonth = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1));
    const nextActualDay = clampDayToMonth(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth(), targetDay);
    nextMonth.setUTCDate(nextActualDay);
    return toDateStr(nextMonth);
}

/**
 * Clamp a target day to the actual number of days in the given month.
 * E.g., day 31 in February -> 28 or 29.
 */
function clampDayToMonth(year: number, month: number, targetDay: number): number {
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return Math.min(targetDay, daysInMonth);
}

/**
 * Compute a custom interval from the base date.
 */
function computeCustomInterval(base: Date, interval: number, unit: "d" | "w" | "m" | "y"): string {
    const next = new Date(base);
    switch (unit) {
        case "d":
            next.setUTCDate(next.getUTCDate() + interval);
            break;
        case "w":
            next.setUTCDate(next.getUTCDate() + interval * 7);
            break;
        case "m": {
            const origDay = next.getUTCDate();
            const targetMonth = next.getUTCMonth() + interval;
            // Set to day 1 first to avoid overflow, then set month, then clamp day
            next.setUTCDate(1);
            next.setUTCMonth(targetMonth);
            const daysInTarget = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
            next.setUTCDate(Math.min(origDay, daysInTarget));
            break;
        }
        case "y": {
            const targetYear = next.getUTCFullYear() + interval;
            const origMonth = next.getUTCMonth();
            next.setUTCFullYear(targetYear);
            // Handle leap year: Feb 29 -> Feb 28
            if (next.getUTCMonth() !== origMonth) {
                next.setUTCDate(0); // Last day of previous month
            }
            break;
        }
    }
    return toDateStr(next);
}

// ─── State Persistence ────────────────────────────────────────────────

/**
 * Get the absolute path to the recurrence state file.
 */
function getStateFilePath(): string {
    return join(getVaultRoot(), STATE_FILE);
}

/**
 * Load recurrence state from disk.
 */
export async function loadRecurrenceState(): Promise<RecurrenceStateFile> {
    const filePath = getStateFilePath();
    try {
        const content = await readFile(filePath, "utf-8");
        const parsed = JSON.parse(content) as RecurrenceStateFile;
        if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
            logger.warn("Invalid recurrence state file, resetting");
            return { version: 1, entries: [] };
        }
        return parsed;
    } catch {
        return { version: 1, entries: [] };
    }
}

/**
 * Save recurrence state to disk.
 */
export async function saveRecurrenceState(state: RecurrenceStateFile): Promise<void> {
    const filePath = getStateFilePath();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * Find a recurrence state entry by task ID.
 */
export function findStateEntry(state: RecurrenceStateFile, taskId: string): RecurrenceState | undefined {
    return state.entries.find((e) => e.taskId === taskId);
}

/**
 * Generate a stable task ID from file path and line number.
 */
export function makeTaskId(filePath: string, lineNum: number): string {
    return `${filePath}:${lineNum}`;
}

/**
 * Update or insert a recurrence state entry.
 */
export function upsertStateEntry(state: RecurrenceStateFile, entry: RecurrenceState): void {
    const idx = state.entries.findIndex((e) => e.taskId === entry.taskId);
    if (idx >= 0) {
        state.entries[idx] = entry;
    } else {
        state.entries.push(entry);
    }
}

/**
 * Remove a recurrence state entry.
 */
export function removeStateEntry(state: RecurrenceStateFile, taskId: string): boolean {
    const idx = state.entries.findIndex((e) => e.taskId === taskId);
    if (idx >= 0) {
        state.entries.splice(idx, 1);
        return true;
    }
    return false;
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Format a Date as an ISO 8601 date string (YYYY-MM-DD).
 */
export function toDateStr(date: Date): string {
    const y = date.getUTCFullYear().toString().padStart(4, "0");
    const m = (date.getUTCMonth() + 1).toString().padStart(2, "0");
    const d = date.getUTCDate().toString().padStart(2, "0");
    return `${y}-${m}-${d}`;
}

/**
 * Parse an ISO date string to a Date object (UTC midnight).
 */
export function fromDateStr(dateStr: string): Date {
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
}

/**
 * Get today's date as YYYY-MM-DD (UTC).
 */
export function todayStr(): string {
    return toDateStr(new Date());
}

/**
 * Check if a date string is before today.
 */
export function isOverdue(dateStr: string): boolean {
    return dateStr < todayStr();
}

/**
 * Build a recurrence task line for insertion into a markdown file.
 * Includes the recurrence emoji pattern in the task line.
 */
export function buildRecurringTaskLine(description: string, pattern: string, dueDate?: string | null): string {
    let line = `- [ ] ${description} ${RECURRENCE_EMOJI} ${pattern}`;
    if (dueDate) {
        line += ` \u{1F4C5} ${dueDate}`;
    }
    return line;
}

/**
 * Compute missed occurrences between lastCompleted and today.
 * Returns the count of missed occurrences (0 if none or if never completed).
 */
export function countMissedOccurrences(rule: RecurrenceRule, lastCompleted: string | null, today: string): number {
    if (!lastCompleted) return 0;

    let count = 0;
    let current = fromDateStr(lastCompleted);
    const todayDate = fromDateStr(today);

    // Safety limit: don't iterate more than 366 times
    for (let i = 0; i < 366; i++) {
        const nextStr = computeNextDueDate(rule, current);
        const nextDate = fromDateStr(nextStr);
        if (nextDate.getTime() >= todayDate.getTime()) break;
        count++;
        current = nextDate;
    }

    return count;
}
