/**
 * Tests for the event bus utility.
 * Covers subscribe, unsubscribe, emit, async emit, filtering, and error handling.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { eventBus, type VaultEvent, type VaultEventType } from "./event-bus.js";

describe("event-bus", () => {
    beforeEach(() => {
        eventBus.clear();
    });

    describe("subscribe and emit", () => {
        it("delivers events to subscribers", async () => {
            const handler = vi.fn();
            eventBus.subscribe(handler);

            const event: VaultEvent = {
                type: "note_created",
                path: "test/note.md",
                timestamp: "2026-10-17T12:00:00Z",
                metadata: {},
            };

            await eventBus.emit(event);
            expect(handler).toHaveBeenCalledWith(event);
        });

        it("delivers to multiple subscribers", async () => {
            const handler1 = vi.fn();
            const handler2 = vi.fn();
            eventBus.subscribe(handler1);
            eventBus.subscribe(handler2);

            const event: VaultEvent = {
                type: "note_updated",
                path: "test/note.md",
                timestamp: "2026-10-17T12:00:00Z",
                metadata: {},
            };

            await eventBus.emit(event);
            expect(handler1).toHaveBeenCalledWith(event);
            expect(handler2).toHaveBeenCalledWith(event);
        });

        it("filters events by type", async () => {
            const handler = vi.fn();
            eventBus.subscribe(handler, ["note_created"]);

            const createdEvent: VaultEvent = {
                type: "note_created",
                path: "test/note.md",
                timestamp: "2026-10-17T12:00:00Z",
                metadata: {},
            };

            const updatedEvent: VaultEvent = {
                type: "note_updated",
                path: "test/note.md",
                timestamp: "2026-10-17T12:00:00Z",
                metadata: {},
            };

            await eventBus.emit(createdEvent);
            await eventBus.emit(updatedEvent);

            expect(handler).toHaveBeenCalledTimes(1);
            expect(handler).toHaveBeenCalledWith(createdEvent);
        });

        it("supports multiple event type filters", async () => {
            const handler = vi.fn();
            eventBus.subscribe(handler, ["note_created", "note_deleted"]);

            const events: VaultEvent[] = [
                { type: "note_created", path: "a.md", timestamp: "", metadata: {} },
                { type: "note_updated", path: "b.md", timestamp: "", metadata: {} },
                { type: "note_deleted", path: "c.md", timestamp: "", metadata: {} },
                { type: "folder_created", path: "d", timestamp: "", metadata: {} },
            ];

            for (const e of events) {
                await eventBus.emit(e);
            }

            expect(handler).toHaveBeenCalledTimes(2);
        });
    });

    describe("unsubscribe", () => {
        it("removes a subscription", async () => {
            const handler = vi.fn();
            const id = eventBus.subscribe(handler);

            const event: VaultEvent = {
                type: "note_created",
                path: "test.md",
                timestamp: "",
                metadata: {},
            };

            await eventBus.emit(event);
            expect(handler).toHaveBeenCalledTimes(1);

            const removed = eventBus.unsubscribe(id);
            expect(removed).toBe(true);

            await eventBus.emit(event);
            expect(handler).toHaveBeenCalledTimes(1); // Still 1
        });

        it("returns false for unknown subscription ID", () => {
            expect(eventBus.unsubscribe("nonexistent")).toBe(false);
        });
    });

    describe("emitAsync", () => {
        it("fires and forgets without blocking", () => {
            const handler = vi.fn().mockResolvedValue(undefined);
            eventBus.subscribe(handler);

            // Should not throw
            eventBus.emitAsync({
                type: "note_created",
                path: "test.md",
                timestamp: "",
                metadata: {},
            });
        });

        it("logs errors from async handlers without throwing", async () => {
            const handler = vi.fn().mockRejectedValue(new Error("handler failed"));
            eventBus.subscribe(handler);

            // Should not throw
            eventBus.emitAsync({
                type: "note_created",
                path: "test.md",
                timestamp: "",
                metadata: {},
            });

            // Wait for async handler to complete
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(handler).toHaveBeenCalled();
        });
    });

    describe("subscriberCount", () => {
        it("tracks the number of active subscriptions", () => {
            expect(eventBus.subscriberCount).toBe(0);

            const id1 = eventBus.subscribe(() => {});
            expect(eventBus.subscriberCount).toBe(1);

            const id2 = eventBus.subscribe(() => {});
            expect(eventBus.subscriberCount).toBe(2);

            eventBus.unsubscribe(id1);
            expect(eventBus.subscriberCount).toBe(1);

            eventBus.unsubscribe(id2);
            expect(eventBus.subscriberCount).toBe(0);
        });
    });

    describe("getEventTypes", () => {
        it("returns all valid event types", () => {
            const types = eventBus.getEventTypes();
            expect(types).toContain("note_created");
            expect(types).toContain("note_updated");
            expect(types).toContain("note_deleted");
            expect(types).toContain("folder_created");
            expect(types).toContain("folder_deleted");
            expect(types).toHaveLength(5);
        });
    });

    describe("clear", () => {
        it("removes all subscriptions", () => {
            eventBus.subscribe(() => {});
            eventBus.subscribe(() => {});
            expect(eventBus.subscriberCount).toBe(2);

            eventBus.clear();
            expect(eventBus.subscriberCount).toBe(0);
        });
    });

    describe("error handling in sync handlers", () => {
        it("catches sync errors and continues delivering to other handlers", async () => {
            const badHandler = vi.fn(() => {
                throw new Error("sync error");
            });
            const goodHandler = vi.fn();

            eventBus.subscribe(badHandler);
            eventBus.subscribe(goodHandler);

            const event: VaultEvent = {
                type: "note_created",
                path: "test.md",
                timestamp: "",
                metadata: {},
            };

            await eventBus.emit(event);

            expect(badHandler).toHaveBeenCalled();
            expect(goodHandler).toHaveBeenCalled();
        });
    });
});
