import { z } from "zod";
import { webhookManager } from "../utils/webhook-manager.js";

export const name = "trigger_webhook";
export const description =
    "Manually trigger a webhook delivery for testing purposes. Sends a custom event payload " +
    "to a specific webhook subscription without requiring an actual vault change.";
export const inputSchema = z.object({
    id: z.string().describe("The webhook subscription ID to trigger"),
    event: z
        .string()
        .default("manual_trigger")
        .describe("Event type name to send (default: manual_trigger)"),
    data: z
        .record(z.unknown())
        .optional()
        .describe("Optional data payload to include in the webhook event"),
});

export async function handler({
    id,
    event,
    data,
}: {
    id: string;
    event: string;
    data?: Record<string, unknown>;
}) {
    const result = await webhookManager.trigger(id, event, data || {});

    if (!result.success) {
        return {
            content: [
                {
                    type: "text" as const,
                    text: `Error triggering webhook "${id}": ${result.error}`,
                },
            ],
            isError: true,
        };
    }

    return {
        content: [
            {
                type: "text" as const,
                text: `Webhook "${id}" triggered successfully with event "${event}".`,
            },
        ],
    };
}
