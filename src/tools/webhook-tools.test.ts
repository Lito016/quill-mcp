/**
 * Tests for webhook tool handlers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { initVault } from "../utils/vault.js";
import { eventBus } from "../utils/event-bus.js";
import { webhookManager } from "../utils/webhook-manager.js";
import { handler as subscribeHandler } from "./subscribe-webhook.js";
import { handler as listHandler } from "./list-webhooks.js";
import { handler as deleteHandler } from "./delete-webhook.js";
import { handler as testHandler } from "./test-webhook.js";
import { handler as triggerHandler } from "./trigger-webhook.js";
import { handler as emitHandler } from "./emit-event.js";

let testCounter = 0;
let TEST_VAULT = "";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("subscribe-webhook tool", () => {
    beforeEach(async () => {
        eventBus.clear();
        mockFetch.mockReset();
        webhookManager.reset();
        TEST_VAULT = join(process.cwd(), `test-vault-wh-sub-${process.pid}-${testCounter++}`);
        await rm(TEST_VAULT, { recursive: true, force: true });
        await mkdir(TEST_VAULT, { recursive: true });
        process.env.NOTES_VAULT_PATH = TEST_VAULT;
        initVault();
    });

    afterEach(async () => {
        eventBus.clear();
        webhookManager.reset();
        delete process.env.NOTES_VAULT_PATH;
        try {
            await rm(TEST_VAULT, { recursive: true, force: true });
        } catch { /* best effort */ }
    }, 10000);

    it("creates a webhook subscription successfully", async () => {
        const result = await subscribeHandler({
            url: "https://example.com/webhook",
            events: ["note_created", "note_updated"],
        });
        expect(result.content[0].text).toContain("subscribed successfully");
        expect(result.content[0].text).toContain("wh_");
    });

    it("rejects invalid URL", async () => {
        const result = await subscribeHandler({
            url: "not-a-url",
            events: ["note_created"],
        }) as { content: { type: "text"; text: string }[]; isError?: boolean };
        expect(result.isError).toBe(true);
    });

    it("supports optional secret", async () => {
        const result = await subscribeHandler({
            url: "https://example.com/webhook",
            events: ["note_created"],
            secret: "my-secret",
        });
        expect(result.content[0].text).toContain("enabled");
    });
});

describe("list-webhooks tool", () => {
    beforeEach(async () => {
        eventBus.clear();
        webhookManager.reset();
        TEST_VAULT = join(process.cwd(), `test-vault-wh-list-${process.pid}-${testCounter++}`);
        await rm(TEST_VAULT, { recursive: true, force: true });
        await mkdir(TEST_VAULT, { recursive: true });
        process.env.NOTES_VAULT_PATH = TEST_VAULT;
        initVault();
    });

    afterEach(async () => {
        eventBus.clear();
        webhookManager.reset();
        delete process.env.NOTES_VAULT_PATH;
        try { await rm(TEST_VAULT, { recursive: true, force: true }); } catch { /* */ }
    }, 10000);

    it("shows empty message when no webhooks exist", async () => {
        const result = await listHandler();
        expect(result.content[0].text).toContain("No webhook subscriptions");
    });

    it("lists existing webhooks", async () => {
        await webhookManager.subscribe({
            url: "https://example.com/a",
            events: ["note_created"],
        });

        const result = await listHandler();
        expect(result.content[0].text).toContain("1 webhook subscription");
        expect(result.content[0].text).toContain("https://example.com/a");
    });
});

describe("delete-webhook tool", () => {
    beforeEach(async () => {
        eventBus.clear();
        webhookManager.reset();
        TEST_VAULT = join(process.cwd(), `test-vault-wh-del-${process.pid}-${testCounter++}`);
        await rm(TEST_VAULT, { recursive: true, force: true });
        await mkdir(TEST_VAULT, { recursive: true });
        process.env.NOTES_VAULT_PATH = TEST_VAULT;
        initVault();
    });

    afterEach(async () => {
        eventBus.clear();
        webhookManager.reset();
        delete process.env.NOTES_VAULT_PATH;
        try { await rm(TEST_VAULT, { recursive: true, force: true }); } catch { /* */ }
    }, 10000);

    it("deletes an existing webhook", async () => {
        const webhook = await webhookManager.subscribe({
            url: "https://example.com/webhook",
            events: ["note_created"],
        });

        const result = await deleteHandler({ id: webhook.id });
        expect(result.content[0].text).toContain("deleted successfully");
    });

    it("returns error for nonexistent webhook", async () => {
        const result = await deleteHandler({ id: "wh_nonexistent" }) as { content: { type: "text"; text: string }[]; isError?: boolean };
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("not found");
    });
});

describe("test-webhook tool", () => {
    beforeEach(async () => {
        mockFetch.mockReset();
        eventBus.clear();
        webhookManager.reset();
        TEST_VAULT = join(process.cwd(), `test-vault-wh-test-${process.pid}-${testCounter++}`);
        await rm(TEST_VAULT, { recursive: true, force: true });
        await mkdir(TEST_VAULT, { recursive: true });
        process.env.NOTES_VAULT_PATH = TEST_VAULT;
        initVault();
    });

    afterEach(async () => {
        eventBus.clear();
        webhookManager.reset();
        delete process.env.NOTES_VAULT_PATH;
        try { await rm(TEST_VAULT, { recursive: true, force: true }); } catch { /* */ }
    }, 10000);

    it("reports success on successful delivery", async () => {
        mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

        const result = await testHandler({ url: "https://example.com/webhook" });
        expect(result.content[0].text).toContain("successful");
    });

    it("reports failure on delivery error", async () => {
        mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

        const result = await testHandler({ url: "https://example.com/webhook" }) as { content: { type: "text"; text: string }[]; isError?: boolean };
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("failed");
    });
});

describe("trigger-webhook tool", () => {
    beforeEach(async () => {
        mockFetch.mockReset();
        eventBus.clear();
        webhookManager.reset();
        TEST_VAULT = join(process.cwd(), `test-vault-wh-trigger-${process.pid}-${testCounter++}`);
        await rm(TEST_VAULT, { recursive: true, force: true });
        await mkdir(TEST_VAULT, { recursive: true });
        process.env.NOTES_VAULT_PATH = TEST_VAULT;
        initVault();
    });

    afterEach(async () => {
        eventBus.clear();
        webhookManager.reset();
        delete process.env.NOTES_VAULT_PATH;
        try { await rm(TEST_VAULT, { recursive: true, force: true }); } catch { /* */ }
    }, 10000);

    it("triggers a webhook manually", async () => {
        mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

        const webhook = await webhookManager.subscribe({
            url: "https://example.com/webhook",
            events: ["note_created"],
        });

        const result = await triggerHandler({ id: webhook.id, event: "custom_event" });
        expect(result.content[0].text).toContain("triggered successfully");
    });

    it("returns error for nonexistent webhook", async () => {
        const result = await triggerHandler({ id: "wh_fake", event: "test" }) as { content: { type: "text"; text: string }[]; isError?: boolean };
        expect(result.isError).toBe(true);
    });
});

describe("emit-event tool", () => {
    beforeEach(() => {
        eventBus.clear();
    });

    afterEach(() => {
        eventBus.clear();
    });

    it("emits an event successfully", async () => {
        const result = await emitHandler({
            type: "note_created",
            path: "test/note.md",
        });
        expect(result.content[0].text).toContain("Event emitted");
        expect(result.content[0].text).toContain("note_created");
    });

    it("includes metadata in event", async () => {
        const handler = vi.fn();
        eventBus.subscribe(handler);

        await emitHandler({
            type: "note_updated",
            path: "test.md",
            metadata: { custom: "data" },
        });

        // Wait for async emit
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(handler).toHaveBeenCalled();
    });
});
