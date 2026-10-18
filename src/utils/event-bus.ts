/**
 * Internal event bus for vault change notifications.
 * Provides a pub/sub pattern so that internal consumers (webhooks, watchers, etc.)
 * can react to vault changes without tight coupling.
 */

import { logger } from "./logger.js";

// ─── Event Types ─────────────────────────────────────────────────────

export type VaultEventType =
    | "note_created"
    | "note_updated"
    | "note_deleted"
    | "folder_created"
    | "folder_deleted";

export interface VaultEvent {
    type: VaultEventType;
    path: string;
    timestamp: string;
    metadata: Record<string, unknown>;
}

export type VaultEventHandler = (event: VaultEvent) => void | Promise<void>;

// ─── Event Bus ───────────────────────────────────────────────────────

const ALL_EVENT_TYPES: VaultEventType[] = [
    "note_created",
    "note_updated",
    "note_deleted",
    "folder_created",
    "folder_deleted",
];

interface Subscription {
    id: string;
    events: VaultEventType[] | null; // null = all events
    handler: VaultEventHandler;
}

let nextSubId = 1;

class EventBus {
    private subscriptions: Map<string, Subscription> = new Map();
    private emitting = false;
    private pendingRemovals: string[] = [];

    /**
     * Subscribe to vault events.
     * @param handler - Callback invoked when a matching event fires.
     * @param events - Optional list of event types to filter on. Null/undefined = all events.
     * @returns Subscription ID that can be used to unsubscribe.
     */
    subscribe(handler: VaultEventHandler, events?: VaultEventType[]): string {
        const id = `sub_${nextSubId++}`;
        this.subscriptions.set(id, {
            id,
            events: events ?? null,
            handler,
        });
        logger.debug("Event bus: new subscription", { id, events: events ?? "all" });
        return id;
    }

    /**
     * Remove a subscription by ID.
     */
    unsubscribe(subscriptionId: string): boolean {
        if (this.emitting) {
            // Defer removal to avoid mutating map during iteration
            this.pendingRemovals.push(subscriptionId);
            return true;
        }
        return this.subscriptions.delete(subscriptionId);
    }

    /**
     * Emit a vault event to all matching subscribers.
     * Handlers are invoked asynchronously; errors are logged but don't block other handlers.
     */
    async emit(event: VaultEvent): Promise<void> {
        this.emitting = true;
        try {
            const handlers: Promise<void>[] = [];
            for (const [, sub] of this.subscriptions) {
                if (sub.events !== null && !sub.events.includes(event.type)) {
                    continue;
                }
                try {
                    const result = sub.handler(event);
                    if (result instanceof Promise) {
                        handlers.push(
                            result.catch((err) => {
                                logger.error("Event bus handler error", {
                                    subscriptionId: sub.id,
                                    eventType: event.type,
                                    error: err instanceof Error ? err.message : String(err),
                                });
                            }),
                        );
                    }
                } catch (err) {
                    logger.error("Event bus handler error (sync)", {
                        subscriptionId: sub.id,
                        eventType: event.type,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            }
            // Wait for all async handlers but don't block on them
            if (handlers.length > 0) {
                await Promise.allSettled(handlers);
            }
        } finally {
            this.emitting = false;
            // Process deferred removals
            for (const id of this.pendingRemovals) {
                this.subscriptions.delete(id);
            }
            this.pendingRemovals = [];
        }
    }

    /**
     * Emit an event without awaiting completion (fire-and-forget).
     * Errors in handlers are logged but never thrown.
     */
    emitAsync(event: VaultEvent): void {
        this.emit(event).catch((err) => {
            logger.error("Event bus async emit error", {
                error: err instanceof Error ? err.message : String(err),
            });
        });
    }

    /**
     * Get the number of active subscriptions.
     */
    get subscriberCount(): number {
        return this.subscriptions.size;
    }

    /**
     * Remove all subscriptions. Used for testing.
     */
    clear(): void {
        this.subscriptions.clear();
        this.pendingRemovals = [];
    }

    /**
     * Get all valid event type strings.
     */
    getEventTypes(): VaultEventType[] {
        return [...ALL_EVENT_TYPES];
    }
}

// Singleton instance
export const eventBus = new EventBus();
