import { z } from "zod";
import { webhookManager } from "../utils/webhook-manager.js";

export const name = "list_webhooks";
export const description =
    "List all webhook subscriptions. Shows webhook IDs, URLs, subscribed events, active status, and creation date.";
export const inputSchema = z.object({});

export async function handler() {
    const webhooks = await webhookManager.list();

    if (webhooks.length === 0) {
        return {
            content: [{ type: "text" as const, text: "No webhook subscriptions found. Use subscribe_webhook to create one." }],
        };
    }

    const lines: string[] = [`Found ${webhooks.length} webhook subscription(s):\n`];

    for (const wh of webhooks) {
        lines.push(`  ID: ${wh.id}`);
        lines.push(`  URL: ${wh.url}`);
        lines.push(`  Events: ${wh.events.join(", ")}`);
        lines.push(`  Active: ${wh.active ? "yes" : "no"}`);
        lines.push(`  Signing: ${wh.secret ? "enabled" : "disabled"}`);
        lines.push(`  Created: ${wh.created}`);
        lines.push("");
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}
