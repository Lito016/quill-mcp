import * as z from "zod";

export const name = "server_status";
export const description =
    "Show HTTP server status, request statistics, and system resource usage. " +
    "Returns information about the HTTP transport layer including active sessions, " +
    "request counts, error rates, uptime, and memory usage.";
export const inputSchema = z.object({
    include_process: z.boolean().default(false).describe("Include detailed process diagnostics"),
});

/**
 * Reference to the HTTP server instance, set by the main module when HTTP mode is active.
 * This allows the tool to report on the HTTP server without creating a circular dependency.
 */
let httpServerRef: { getStats: () => HttpServerStatsLike } | null = null;

interface HttpServerStatsLike {
    running: boolean;
    port: number;
    host: string;
    uptimeMs: number;
    totalRequests: number;
    activeSessions: number;
    errors: number;
    requestsByEndpoint: Record<string, number>;
    avgResponseTimeMs: number;
}

/**
 * Register the HTTP server instance for status reporting.
 * Called by the main module during startup.
 */
export function setHttpServerRef(ref: { getStats: () => HttpServerStatsLike } | null): void {
    httpServerRef = ref;
}

export async function handler({ include_process = false }: { include_process?: boolean }) {
    const memUsage = process.memoryUsage();

    const result: Record<string, unknown> = {
        server: {
            name: "quill-mcp",
            version: "1.0.0",
            node_version: process.version,
            platform: process.platform,
        },
        http: httpServerRef
            ? httpServerRef.getStats()
            : {
                  running: false,
                  message: "HTTP server not enabled. Start with --http flag or set QUILL_HTTP_ENABLED=true.",
              },
        process: {
            uptime_ms: Math.round(process.uptime() * 1000),
            memory: {
                heap_used_mb: Math.round(memUsage.heapUsed / 1024 / 1024),
                heap_total_mb: Math.round(memUsage.heapTotal / 1024 / 1024),
                rss_mb: Math.round(memUsage.rss / 1024 / 1024),
            },
        },
    };

    if (include_process) {
        result.process = {
            ...(result.process as Record<string, unknown>),
            memory: {
                ...((result.process as Record<string, unknown>).memory as Record<string, unknown>),
                external_mb: Math.round(memUsage.external / 1024 / 1024),
                array_buffers_mb: Math.round((memUsage.arrayBuffers || 0) / 1024 / 1024),
            },
            pid: process.pid,
            cpu_usage: process.cpuUsage(),
        };
    }

    return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
}
