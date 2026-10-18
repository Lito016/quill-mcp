/**
 * Webhook manager for quill-mcp.
 * Manages webhook subscriptions stored in .webhooks.json at the vault root.
 * Delivers HTTP POST payloads with optional HMAC signing and retry logic.
 */

import { createHmac, randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getVaultRoot } from "./vault.js";
import { eventBus, type VaultEvent, type VaultEventType } from "./event-bus.js";
import { logger } from "./logger.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface WebhookSubscription {
    id: string;
    url: string;
    events: VaultEventType[];
    secret?: string;
    active: boolean;
    created: string;
}

export interface WebhookPayload {
    event: string;
    timestamp: string;
    data: {
        path: string;
        size?: number;
        tags?: string[];
        [key: string]: unknown;
    };
}

interface WebhooksFile {
    webhooks: WebhookSubscription[];
}

interface DeliveryAttempt {
    webhookId: string;
    url: string;
    event: string;
    timestamp: string;
    success: boolean;
    statusCode?: number;
    error?: string;
    attempt: number;
}

// ─── Constants ───────────────────────────────────────────────────────

const WEBHOOKS_FILE = ".webhooks.json";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_DELIVERIES_PER_MINUTE = 100;

// ─── Rate Limiter (per webhook) ──────────────────────────────────────

const deliveryWindows = new Map<string, number[]>();

function checkDeliveryRateLimit(webhookId: string): boolean {
    const now = Date.now();
    const windowStart = now - 60_000;

    let timestamps = deliveryWindows.get(webhookId);
    if (!timestamps) {
        timestamps = [];
        deliveryWindows.set(webhookId, timestamps);
    }

    // Remove expired timestamps
    timestamps.splice(0, timestamps.findIndex((t) => t > windowStart));

    if (timestamps.length >= MAX_DELIVERIES_PER_MINUTE) {
        return false;
    }

    timestamps.push(now);
    return true;
}

// ─── Webhook Manager ─────────────────────────────────────────────────

class WebhookManager {
    private webhooks: WebhookSubscription[] = [];
    private loaded = false;
    private deliveryLog: DeliveryAttempt[] = [];
    private subscriptionId: string | null = null;

    /**
     * Load webhooks from the .webhooks.json file.
     */
    async load(): Promise<void> {
        const filePath = join(getVaultRoot(), WEBHOOKS_FILE);
        try {
            const content = await readFile(filePath, "utf-8");
            const data: WebhooksFile = JSON.parse(content);
            this.webhooks = data.webhooks || [];
        } catch {
            // File doesn't exist or is invalid — start with empty list
            this.webhooks = [];
        }
        this.loaded = true;
    }

    /**
     * Save webhooks to the .webhooks.json file.
     */
    private async save(): Promise<void> {
        const filePath = join(getVaultRoot(), WEBHOOKS_FILE);
        const data: WebhooksFile = { webhooks: this.webhooks };
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
    }

    /**
     * Ensure webhooks are loaded before any operation.
     */
    private async ensureLoaded(): Promise<void> {
        if (!this.loaded) {
            await this.load();
        }
    }

    /**
     * Subscribe a new webhook.
     */
    async subscribe(params: {
        url: string;
        events: VaultEventType[];
        secret?: string;
    }): Promise<WebhookSubscription> {
        await this.ensureLoaded();

        const id = `wh_${randomBytes(6).toString("hex")}`;
        const webhook: WebhookSubscription = {
            id,
            url: params.url,
            events: params.events,
            secret: params.secret,
            active: true,
            created: new Date().toISOString(),
        };

        this.webhooks.push(webhook);
        await this.save();

        // Ensure event bus listener is active
        this.ensureBusSubscription();

        logger.info("Webhook subscribed", { id, url: params.url, events: params.events });
        return webhook;
    }

    /**
     * List all webhook subscriptions.
     */
    async list(): Promise<WebhookSubscription[]> {
        await this.ensureLoaded();
        return [...this.webhooks];
    }

    /**
     * Delete a webhook subscription by ID.
     */
    async delete(id: string): Promise<boolean> {
        await this.ensureLoaded();
        const index = this.webhooks.findIndex((w) => w.id === id);
        if (index === -1) return false;

        this.webhooks.splice(index, 1);
        await this.save();

        // If no webhooks remain, unsubscribe from bus
        if (this.webhooks.length === 0) {
            this.removeBusSubscription();
        }

        logger.info("Webhook deleted", { id });
        return true;
    }

    /**
     * Send a test event to a webhook URL to verify connectivity.
     */
    async testDelivery(url: string, secret?: string): Promise<{ success: boolean; statusCode?: number; error?: string }> {
        const testPayload: WebhookPayload = {
            event: "test",
            timestamp: new Date().toISOString(),
            data: {
                path: "test/example.md",
                size: 0,
                tags: ["test"],
            },
        };

        return this.deliverPayload(url, testPayload, secret);
    }

    /**
     * Manually trigger a webhook with a custom event.
     */
    async trigger(id: string, eventType: string, data: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
        await this.ensureLoaded();
        const webhook = this.webhooks.find((w) => w.id === id);
        if (!webhook) {
            return { success: false, error: `Webhook not found: ${id}` };
        }
        if (!webhook.active) {
            return { success: false, error: `Webhook is inactive: ${id}` };
        }

        const payload: WebhookPayload = {
            event: eventType,
            timestamp: new Date().toISOString(),
            data: {
                path: data.path as string || "manual/trigger.md",
                ...data,
            },
        };

        const result = await this.deliverPayload(webhook.url, payload, webhook.secret);
        return { success: result.success, error: result.error };
    }

    /**
     * Start listening to event bus and delivering webhooks.
     */
    startListening(): void {
        this.ensureBusSubscription();
    }

    /**
     * Stop listening to event bus.
     */
    stopListening(): void {
        this.removeBusSubscription();
    }

    /**
     * Get delivery log for debugging.
     */
    getDeliveryLog(): DeliveryAttempt[] {
        return [...this.deliveryLog];
    }

    /**
     * Clear the delivery log.
     */
    clearDeliveryLog(): void {
        this.deliveryLog = [];
    }

    /**
     * Reset all state. Used for testing.
     */
    reset(): void {
        this.webhooks = [];
        this.loaded = false;
        this.deliveryLog = [];
        this.removeBusSubscription();
    }

    // ─── Internal ────────────────────────────────────────────────────

    private ensureBusSubscription(): void {
        if (this.subscriptionId !== null) return;
        this.subscriptionId = eventBus.subscribe(
            (event) => this.handleEvent(event),
        );
    }

    private removeBusSubscription(): void {
        if (this.subscriptionId !== null) {
            eventBus.unsubscribe(this.subscriptionId);
            this.subscriptionId = null;
        }
    }

    private async handleEvent(event: VaultEvent): Promise<void> {
        await this.ensureLoaded();

        const matchingWebhooks = this.webhooks.filter(
            (w) => w.active && w.events.includes(event.type),
        );

        for (const webhook of matchingWebhooks) {
            // Check rate limit
            if (!checkDeliveryRateLimit(webhook.id)) {
                logger.warn("Webhook rate limited", { id: webhook.id, url: webhook.url });
                this.logDelivery({
                    webhookId: webhook.id,
                    url: webhook.url,
                    event: event.type,
                    timestamp: event.timestamp,
                    success: false,
                    error: "Rate limit exceeded (100 deliveries/minute)",
                    attempt: 0,
                });
                continue;
            }

            const payload: WebhookPayload = {
                event: event.type,
                timestamp: event.timestamp,
                data: {
                    path: event.path,
                    ...event.metadata,
                },
            };

            // Fire-and-forget delivery with retry
            this.deliverWithRetry(webhook, payload, event).catch((err) => {
                logger.error("Webhook delivery failed after retries", {
                    id: webhook.id,
                    error: err instanceof Error ? err.message : String(err),
                });
            });
        }
    }

    private async deliverWithRetry(
        webhook: WebhookSubscription,
        payload: WebhookPayload,
        originalEvent: VaultEvent,
    ): Promise<void> {
        let lastError: string | undefined;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            const result = await this.deliverPayload(webhook.url, payload, webhook.secret);

            this.logDelivery({
                webhookId: webhook.id,
                url: webhook.url,
                event: originalEvent.type,
                timestamp: originalEvent.timestamp,
                success: result.success,
                statusCode: result.statusCode,
                error: result.error,
                attempt,
            });

            if (result.success) {
                return;
            }

            lastError = result.error;

            // Exponential backoff before retry
            if (attempt < MAX_RETRIES) {
                const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }

        logger.error("Webhook delivery exhausted retries", {
            id: webhook.id,
            url: webhook.url,
            error: lastError,
            attempts: MAX_RETRIES,
        });
    }

    private async deliverPayload(
        url: string,
        payload: WebhookPayload,
        secret?: string,
    ): Promise<{ success: boolean; statusCode?: number; error?: string }> {
        try {
            const body = JSON.stringify(payload);
            const headers: Record<string, string> = {
                "Content-Type": "application/json",
                "User-Agent": "quill-mcp-webhook/1.0",
            };

            // HMAC signing
            if (secret) {
                const signature = createHmac("sha256", secret).update(body).digest("hex");
                headers["X-Webhook-Signature"] = `sha256=${signature}`;
            }

            const response = await fetch(url, {
                method: "POST",
                headers,
                body,
                signal: AbortSignal.timeout(10_000),
            });

            if (response.ok) {
                return { success: true, statusCode: response.status };
            }

            return {
                success: false,
                statusCode: response.status,
                error: `HTTP ${response.status}: ${response.statusText}`,
            };
        } catch (err) {
            return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    private logDelivery(attempt: DeliveryAttempt): void {
        this.deliveryLog.push(attempt);
        // Keep log bounded
        if (this.deliveryLog.length > 1000) {
            this.deliveryLog = this.deliveryLog.slice(-500);
        }

        if (attempt.success) {
            logger.debug("Webhook delivered", {
                id: attempt.webhookId,
                event: attempt.event,
                attempt: attempt.attempt,
            });
        } else {
            logger.warn("Webhook delivery failed", {
                id: attempt.webhookId,
                event: attempt.event,
                attempt: attempt.attempt,
                error: attempt.error,
            });
        }
    }
}

// Singleton instance
export const webhookManager = new WebhookManager();

/**
 * Validate that a URL is a valid HTTP/HTTPS webhook endpoint.
 */
export function isValidWebhookUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
        return false;
    }
}
