import { z } from "zod";
import { webhookManager, isValidWebhookUrl } from "../utils/webhook-manager.js";

export const name = "test_webhook";
export const description =
    "Send a test event to a webhook URL to verify connectivity and payload format. " +
    "Does not require an existing subscription — useful for validating endpoints before subscribing.";
export const inputSchema = z.object({
    url: z.string().url().describe("The webhook URL to test"),
    secret: z.string().optional().describe("Optional signing secret (must match the subscription secret if used)"),
});

export async function handler({ url, secret }: { url: string; secret?: string }) {
    if (!isValidWebhookUrl(url)) {
        return {
            content: [{ type: "text" as const, text: "Error: URL must be a valid HTTP or HTTPS URL." }],
            isError: true,
        };
    }

    const result = await webhookManager.testDelivery(url, secret);

    if (result.success) {
        return {
            content: [
                {
                    type: "text" as const,
                    text:
                        `Webhook test successful!\n` +
                        `  URL: ${url}\n` +
                        `  Status: ${result.statusCode}\n` +
                        `  Signing: ${secret ? "enabled" : "disabled"}\n\n` +
                        `The endpoint accepted the test payload.`,
                },
            ],
        };
    }

    return {
        content: [
            {
                type: "text" as const,
                text:
                    `Webhook test failed.\n` +
                    `  URL: ${url}\n` +
                    `  Error: ${result.error}\n` +
                    `  Status: ${result.statusCode ?? "N/A"}\n\n` +
                    `Check that the URL is reachable and accepts POST requests with JSON bodies.`,
            },
        ],
        isError: true,
    };
}
