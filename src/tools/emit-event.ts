import { z } from "zod";
import { eventBus, type VaultEventType } from "../utils/event-bus.js";

export const name = "emit_event";
export const description =
    "Manually emit a custom vault event. Useful for automation workflows and testing " +
    "the event pipeline. The event is dispatched to all subscribers including webhooks.";
export const inputSchema = z.object({
    type: z
        .enum(["note_created", "note_updated", "note_deleted", "folder_created", "folder_deleted"])
        .describe("The event type to emit"),
    path: z.string().describe("The vault-relative path associated with this event"),
    metadata: z
        .record(z.unknown())
        .optional()
        .describe("Optional metadata to include with the event"),
});

export async function handler({
    type,
    path,
    metadata,
}: {
    type: VaultEventType;
    path: string;
    metadata?: Record<string, unknown>;
}) {
    const event = {
        type,
        path,
        timestamp: new Date().toISOString(),
        metadata: metadata || {},
    };

    // Fire-and-forget: emit async so we don't block the response on webhook delivery
    eventBus.emitAsync(event);

    return {
        content: [
            {
                type: "text" as const,
                text:
                    `Event emitted successfully.\n` +
                    `  Type: ${type}\n` +
                    `  Path: ${path}\n` +
                    `  Timestamp: ${event.timestamp}\n` +
                    `  Subscribers: ${eventBus.subscriberCount}\n\n` +
                    `The event has been dispatched to all matching subscribers.`,
            },
        ],
    };
}
