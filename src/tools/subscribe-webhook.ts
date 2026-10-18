import { z } from "zod";
import { webhookManager, isValidWebhookUrl } from "../utils/webhook-manager.js";
import { eventBus } from "../utils/event-bus.js";
import type { VaultEventType } from "../utils/event-bus.js";

export const name = "subscribe_webhook";
export const description =
    "Register a new webhook subscription to receive notifications when vault changes occur. " +
    "The webhook URL must be a valid HTTP/HTTPS endpoint. Events are delivered as HTTP POST requests " +
    "with JSON payloads. Optional HMAC signing via a shared secret adds an X-Webhook-Signature header.";
export const inputSchema = z.object({
    url: z.string().url().describe("The HTTP/HTTPS URL to receive webhook POST requests"),
    events: z
        .array(z.enum(["note_created", "note_updated", "note_deleted", "folder_created", "folder_deleted"]))
        .min(1)
        .describe("List of event types to subscribe to"),
    secret: z
        .string()
        .optional()
        .describe("Optional shared secret for HMAC-SHA256 signing (adds X-Webhook-Signature header)"),
});

export async function handler({
    url,
    events,
    secret,
}: {
    url: string;
    events: VaultEventType[];
    secret?: string;
}) {
    if (!isValidWebhookUrl(url)) {
        return {
            content: [{ type: "text" as const, text: "Error: Webhook URL must be a valid HTTP or HTTPS URL." }],
            isError: true,
        };
    }

    // Validate event types
    const validTypes = eventBus.getEventTypes();
    const invalidEvents = events.filter((e) => !validTypes.includes(e));
    if (invalidEvents.length > 0) {
        return {
            content: [
                {
                    type: "text" as const,
                    text: `Error: Invalid event type(s): ${invalidEvents.join(", ")}. Valid types: ${validTypes.join(", ")}`,
                },
            ],
            isError: true,
        };
    }

    const webhook = await webhookManager.subscribe({ url, events, secret });

    return {
        content: [
            {
                type: "text" as const,
                text:
                    `Webhook subscribed successfully.\n` +
                    `  ID: ${webhook.id}\n` +
                    `  URL: ${webhook.url}\n` +
                    `  Events: ${webhook.events.join(", ")}\n` +
                    `  Signing: ${secret ? "enabled (HMAC-SHA256)" : "disabled"}\n` +
                    `  Created: ${webhook.created}\n\n` +
                    `Use test_webhook to verify delivery, or list_webhooks to manage subscriptions.`,
            },
        ],
    };
}
