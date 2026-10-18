import { z } from "zod";
import { webhookManager } from "../utils/webhook-manager.js";

export const name = "delete_webhook";
export const description = "Remove a webhook subscription by its ID. Use list_webhooks to find webhook IDs.";
export const inputSchema = z.object({
    id: z.string().describe("The webhook subscription ID to delete (e.g. wh_abc123)"),
});

export async function handler({ id }: { id: string }) {
    const deleted = await webhookManager.delete(id);

    if (!deleted) {
        return {
            content: [{ type: "text" as const, text: `Error: Webhook not found: "${id}". Use list_webhooks to see available subscriptions.` }],
            isError: true,
        };
    }

    return {
        content: [{ type: "text" as const, text: `Webhook "${id}" deleted successfully.` }],
    };
}
