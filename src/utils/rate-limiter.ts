/**
 * Per-tool rate limiting to prevent abuse and resource exhaustion.
 * Uses a sliding window counter algorithm for accurate rate tracking.
 */

import { logger } from "./logger.js";

export interface RateLimitConfig {
    /** Maximum requests allowed in the window */
    maxRequests: number;
    /** Window size in milliseconds */
    windowMs: number;
}

export interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    resetMs: number;
    retryAfterMs?: number;
}

// Default rate limits per tool category
const DEFAULT_LIMITS: Record<string, RateLimitConfig> = {
    // Read operations: higher limits
    read: { maxRequests: 100, windowMs: 60_000 },
    // Search operations: moderate limits
    search: { maxRequests: 50, windowMs: 60_000 },
    // Write operations: lower limits
    write: { maxRequests: 30, windowMs: 60_000 },
    // Batch operations: strict limits
    batch: { maxRequests: 10, windowMs: 60_000 },
    // Memory operations: moderate limits
    memory: { maxRequests: 40, windowMs: 60_000 },
};

// Tool-to-category mapping
const TOOL_CATEGORIES: Record<string, string> = {
    read_note: "read",
    list_notes: "read",
    list_folder: "read",
    note_info: "read",
    vault_status: "read",
    list_trash: "read",
    extract_tags: "read",
    extract_links: "read",
    extract_callouts: "read",
    find_backlinks: "read",
    search_by_name: "read",
    search_by_tag: "read",
    read_frontmatter: "read",
    session_history: "read",
    discover: "read",
    search_files: "read",
    quill_retrieve: "read",
    quill_recall: "read",
    quill_audit: "read",
    watch_changes: "read",
    vault_guide: "read",
    health_check: "read",
    graph_neighborhood: "read",
    vault_health_audit: "read",
    note_undo: "read",
    batch_read: "read",
    preview_changes: "read",
    apply_change_plan: "write",

    search_notes: "search",
    quill_detect_conflicts: "search",

    write_note: "write",
    create_note: "write",
    append_note: "write",
    move_note: "write",
    copy_note: "write",
    delete_note: "write",
    create_folder: "write",
    delete_folder: "write",
    rename_folder: "write",
    restore_note: "write",
    write_frontmatter: "write",
    update_frontmatter: "write",
    quill_write: "write",
    quill_record_decision: "write",
    quill_record_lesson: "write",
    quill_record_discovery: "write",
    quill_resolve_conflict: "write",
    quill_checkpoint: "write",
    quill_session_start: "write",
    quill_session_end: "write",
    generate_hive_canvas: "write",
    refresh_knowledge_index: "write",
    note_sections: "write", // Can replace section content

    batch_delete: "batch",
    batch_move: "batch",

    quill_consolidate: "memory",
    quill_restore: "memory",

    subscribe_webhook: "write",
    list_webhooks: "read",
    delete_webhook: "write",
    test_webhook: "write",
    trigger_webhook: "write",
    emit_event: "write",
};

interface SlidingWindow {
    timestamps: number[];
}

class RateLimiter {
    private windows = new Map<string, SlidingWindow>();
    private limits: Record<string, RateLimitConfig>;

    constructor(limits?: Record<string, RateLimitConfig>) {
        this.limits = limits ?? DEFAULT_LIMITS;
    }

    /**
     * Check if a tool call is allowed under rate limits.
     */
    check(toolName: string): RateLimitResult {
        const category = TOOL_CATEGORIES[toolName] ?? "read";
        const config = this.limits[category] ?? this.limits.read;
        const now = Date.now();
        const windowStart = now - config.windowMs;

        let window = this.windows.get(toolName);
        if (!window) {
            window = { timestamps: [] };
            this.windows.set(toolName, window);
        }

        // Remove timestamps outside the window
        window.timestamps = window.timestamps.filter((t) => t > windowStart);

        const requestCount = window.timestamps.length;
        const remaining = Math.max(0, config.maxRequests - requestCount);

        if (requestCount >= config.maxRequests) {
            // Rate limited
            const oldestInWindow = window.timestamps[0];
            const resetMs = oldestInWindow + config.windowMs - now;
            return {
                allowed: false,
                remaining: 0,
                resetMs,
                retryAfterMs: resetMs,
            };
        }

        // Allowed - record the timestamp
        window.timestamps.push(now);

        return {
            allowed: true,
            remaining: remaining - 1,
            resetMs: config.windowMs,
        };
    }

    /**
     * Reset rate limit tracking for a specific tool or all tools.
     */
    reset(toolName?: string): void {
        if (toolName) {
            this.windows.delete(toolName);
        } else {
            this.windows.clear();
        }
    }

    /**
     * Get current rate limit status for a tool without recording a request.
     */
    status(toolName: string): { remaining: number; resetMs: number } {
        const category = TOOL_CATEGORIES[toolName] ?? "read";
        const config = this.limits[category] ?? this.limits.read;
        const now = Date.now();
        const windowStart = now - config.windowMs;

        const window = this.windows.get(toolName);
        if (!window) {
            return { remaining: config.maxRequests, resetMs: config.windowMs };
        }

        const activeCount = window.timestamps.filter((t) => t > windowStart).length;
        const remaining = Math.max(0, config.maxRequests - activeCount);

        return {
            remaining,
            resetMs: window.timestamps.length > 0 ? window.timestamps[0] + config.windowMs - now : config.windowMs,
        };
    }

    /**
     * Clean up expired windows to prevent memory leaks.
     * Call periodically (e.g., every 5 minutes).
     */
    cleanup(): void {
        const now = Date.now();
        for (const [toolName, window] of this.windows.entries()) {
            const activeTimestamps = window.timestamps.filter((t) => t > now - 120_000);
            if (activeTimestamps.length === 0) {
                this.windows.delete(toolName);
            } else {
                window.timestamps = activeTimestamps;
            }
        }
    }
}

// Singleton instance
export const rateLimiter = new RateLimiter();

// Cleanup interval to prevent memory leaks
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function startRateLimiterCleanup(): void {
    if (!cleanupInterval) {
        cleanupInterval = setInterval(() => rateLimiter.cleanup(), 5 * 60_000);
        // Allow the process to exit even if the interval is active
        if (cleanupInterval.unref) {
            cleanupInterval.unref();
        }
    }
}

export function stopRateLimiterCleanup(): void {
    if (cleanupInterval) {
        clearInterval(cleanupInterval);
        cleanupInterval = null;
    }
}

/**
 * Create a rate limiter middleware for a specific tool.
 * Returns an error message if rate limited, or null if allowed.
 */
export function checkRateLimit(toolName: string): string | null {
    const result = rateLimiter.check(toolName);
    if (!result.allowed) {
        const retrySeconds = Math.ceil((result.retryAfterMs ?? 1000) / 1000);
        logger.warn(`Rate limit exceeded for tool "${toolName}"`, {
            retryAfterMs: result.retryAfterMs,
            resetMs: result.resetMs,
        });
        return `Rate limit exceeded. Try again in ${retrySeconds} second(s).`;
    }
    return null;
}
