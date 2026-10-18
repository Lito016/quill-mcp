import * as z from "zod";
import { getVaultRoot, pathExists } from "../utils/vault.js";
import { getConfig } from "../utils/config.js";
import { knowledgeIndex } from "../utils/knowledge-index.js";
import { readdir } from "node:fs/promises";

export const name = "health_check";
export const description =
    "Check server health and readiness. Returns vault status, index sync state, and basic diagnostics. Use this to verify the server is working correctly.";
export const inputSchema = z.object({
    verbose: z.boolean().default(false).describe("Include detailed diagnostics"),
});

export async function handler({ verbose = false }: { verbose?: boolean }) {
    const vaultPath = getVaultRoot();
    const config = getConfig();
    const startTime = Date.now();

    const health: Record<string, unknown> = {
        status: "ok",
        timestamp: new Date().toISOString(),
        uptime_ms: process.uptime() * 1000,
    };

    // Check vault accessibility
    try {
        const exists = await pathExists(vaultPath);
        health.vault = {
            path: vaultPath,
            accessible: exists,
            status: exists ? "ok" : "missing",
        };
        if (!exists) {
            health.status = "degraded";
        }
    } catch (err) {
        health.vault = {
            path: vaultPath,
            accessible: false,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
        };
        health.status = "degraded";
    }

    // Check knowledge index
    try {
        await knowledgeIndex.ensureSynchronized();
        health.index = {
            status: "synced",
            last_sync: new Date().toISOString(),
        };
    } catch (err) {
        health.index = {
            status: "error",
            error: err instanceof Error ? err.message : String(err),
        };
        health.status = "degraded";
    }

    // Check config
    health.config = {
        guide_entries: Object.keys(config.guide || {}).length,
        memory_enabled: config.memory.enabled,
    };

    // Verbose diagnostics
    if (verbose) {
        try {
            const entries = await readdir(vaultPath, { withFileTypes: true });
            const folders = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).length;
            const files = entries.filter((e) => e.isFile()).length;
            health.diagnostics = {
                root_folders: folders,
                root_files: files,
                node_version: process.version,
                platform: process.platform,
                memory_usage_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            };
        } catch {
            // Skip if scan fails
        }
    }

    const elapsed = Date.now() - startTime;

    return {
        content: [
            {
                type: "text" as const,
                text: JSON.stringify({ ...health, check_duration_ms: elapsed }, null, 2),
            },
        ],
    };
}
