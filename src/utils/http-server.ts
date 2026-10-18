/**
 * HTTP server module for quill-mcp.
 *
 * Provides an HTTP transport alongside the existing stdio transport,
 * enabling remote access to the MCP vault server. Uses Node.js built-in
 * `http` module with the SDK's WebStandardStreamableHTTPServerTransport
 * for MCP protocol handling.
 *
 * Endpoints:
 *   POST /mcp     - JSON-RPC endpoint for MCP protocol
 *   GET  /mcp     - SSE stream for server notifications
 *   DELETE /mcp   - Session termination
 *   GET  /health  - Health check
 *   GET  /status  - Vault status and stats
 *   GET  /tools   - List available tools
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "./logger.js";

// ─── Types ─────────────────────────────────────────────────────────────

export interface HttpServerConfig {
    enabled: boolean;
    port: number;
    host: string;
    authToken?: string;
    corsOrigins?: string[];
}

export interface HttpServerStats {
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

interface IpRateEntry {
    count: number;
    resetAt: number;
}

// ─── Constants ─────────────────────────────────────────────────────────

const DEFAULT_RATE_LIMIT = 1000;
const RATE_WINDOW_MS = 60_000;
const MAX_REQUEST_SIZE = 10 * 1024 * 1024; // 10MB

// ─── HTTP Server Class ─────────────────────────────────────────────────

export class QuillHttpServer {
    private server: Server | null = null;
    private config: HttpServerConfig;
    private mcpServer: McpServer;
    private startTime = 0;
    private transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

    // Stats
    private totalRequests = 0;
    private totalErrors = 0;
    private totalResponseTimeMs = 0;
    private requestsByEndpoint: Record<string, number> = {};

    // Rate limiting: per-IP sliding window
    private ipRates = new Map<string, IpRateEntry>();
    private rateLimitCleanup: ReturnType<typeof setInterval> | null = null;

    constructor(config: HttpServerConfig, mcpServer: McpServer) {
        this.config = config;
        this.mcpServer = mcpServer;
    }

    /**
     * Start the HTTP server.
     */
    async start(): Promise<void> {
        if (this.server) {
            throw new Error("HTTP server already running");
        }

        this.startTime = Date.now();
        this.server = createServer((req, res) => this.handleRequest(req, res));

        await new Promise<void>((resolve, reject) => {
            this.server!.listen(this.config.port, this.config.host, () => {
                logger.info("HTTP server started", {
                    host: this.config.host,
                    port: this.config.port,
                    auth: !!this.config.authToken,
                });
                resolve();
            });
            this.server!.on("error", (err) => {
                logger.error("HTTP server error", { error: err.message });
                reject(err);
            });
        });

        // Periodic cleanup for rate limiter entries
        this.rateLimitCleanup = setInterval(() => this.cleanupRateLimits(), 5 * 60_000);
        if (this.rateLimitCleanup.unref) {
            this.rateLimitCleanup.unref();
        }
    }

    /**
     * Stop the HTTP server gracefully.
     */
    async stop(): Promise<void> {
        if (this.rateLimitCleanup) {
            clearInterval(this.rateLimitCleanup);
            this.rateLimitCleanup = null;
        }

        // Close all active transports
        for (const [sessionId, transport] of this.transports) {
            try {
                await transport.close();
            } catch (err) {
                logger.error("Error closing transport", {
                    sessionId,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
        this.transports.clear();

        if (this.server) {
            await new Promise<void>((resolve) => {
                this.server!.close(() => resolve());
            });
            this.server = null;
            logger.info("HTTP server stopped");
        }
    }

    /**
     * Get current server statistics.
     */
    getStats(): HttpServerStats {
        const totalReqs = this.totalRequests || 1;
        return {
            running: this.server !== null && this.server.listening,
            port: this.config.port,
            host: this.config.host,
            uptimeMs: this.startTime ? Date.now() - this.startTime : 0,
            totalRequests: this.totalRequests,
            activeSessions: this.transports.size,
            errors: this.totalErrors,
            requestsByEndpoint: { ...this.requestsByEndpoint },
            avgResponseTimeMs: Math.round(this.totalResponseTimeMs / totalReqs),
        };
    }

    // ─── Request Handling ──────────────────────────────────────────

    private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const start = Date.now();
        this.totalRequests++;

        const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
        const pathname = url.pathname;
        const endpoint = `${req.method} ${pathname}`;
        this.requestsByEndpoint[endpoint] = (this.requestsByEndpoint[endpoint] || 0) + 1;

        try {
            // CORS preflight
            if (req.method === "OPTIONS") {
                this.handleCorsPreflight(req, res);
                return;
            }

            // Auth check
            if (!this.checkAuth(req)) {
                this.totalErrors++;
                this.sendJson(res, 401, { error: "Unauthorized" });
                return;
            }

            // Rate limiting
            if (!this.checkRateLimit(req)) {
                this.totalErrors++;
                res.setHeader("Retry-After", "60");
                this.sendJson(res, 429, { error: "Rate limit exceeded. Try again in 60 seconds." });
                return;
            }

            // CORS headers on all responses
            this.setCorsHeaders(req, res);

            // Route to handler
            switch (pathname) {
                case "/mcp":
                    await this.handleMcp(req, res);
                    break;
                case "/health":
                    this.handleHealth(req, res);
                    break;
                case "/status":
                    this.handleStatus(req, res);
                    break;
                case "/tools":
                    await this.handleTools(req, res);
                    break;
                default:
                    this.sendJson(res, 404, { error: "Not found" });
                    break;
            }
        } catch (err) {
            this.totalErrors++;
            logger.error("HTTP request error", {
                method: req.method,
                path: pathname,
                error: err instanceof Error ? err.message : String(err),
            });
            if (!res.headersSent) {
                this.sendJson(res, 500, { error: "Internal server error" });
            }
        } finally {
            const duration = Date.now() - start;
            this.totalResponseTimeMs += duration;
            this.logRequest(req, res.statusCode || 0, duration);
        }
    }

    // ─── MCP Endpoint ──────────────────────────────────────────────

    private async handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;

        if (sessionId && this.transports.has(sessionId)) {
            // Existing session — reuse transport
            const transport = this.transports.get(sessionId)!;
            await this.handleWebStandardRequest(req, res, transport);
            return;
        }

        if (req.method === "POST") {
            // Read body to check if this is an initialization request
            const body = await this.readBody(req);
            if (!body) {
                this.sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error: empty body" }, id: null });
                return;
            }

            let parsed: unknown;
            try {
                parsed = JSON.parse(body);
            } catch {
                this.sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error: invalid JSON" }, id: null });
                return;
            }

            if (isInitializeRequest(parsed)) {
                // New session — create transport and connect
                const transport = new WebStandardStreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    onsessioninitialized: (newSessionId) => {
                        this.transports.set(newSessionId, transport);
                        logger.info("MCP session initialized", { sessionId: newSessionId });
                    },
                });

                transport.onclose = () => {
                    const sid = transport.sessionId;
                    if (sid && this.transports.has(sid)) {
                        this.transports.delete(sid);
                        logger.info("MCP session closed", { sessionId: sid });
                    }
                };

                // Connect transport to MCP server
                await this.mcpServer.connect(transport);
                await this.handleWebStandardRequestWithBody(req, res, transport, parsed);
                return;
            }
        }

        // No valid session and not an initialization request
        this.sendJson(res, 400, {
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: No valid session ID. Send an initialize request first." },
            id: null,
        });
    }

    /**
     * Convert Node.js HTTP request to Web Standard Request and pass to transport.
     */
    private async handleWebStandardRequest(
        req: IncomingMessage,
        res: ServerResponse,
        transport: WebStandardStreamableHTTPServerTransport,
    ): Promise<void> {
        const body = await this.readBody(req);
        const parsed = body ? JSON.parse(body) : undefined;
        await this.handleWebStandardRequestWithBody(req, res, transport, parsed);
    }

    private async handleWebStandardRequestWithBody(
        req: IncomingMessage,
        res: ServerResponse,
        transport: WebStandardStreamableHTTPServerTransport,
        parsedBody: unknown,
    ): Promise<void> {
        const url = new URL(req.url || "/mcp", `http://${req.headers.host || "localhost"}`);
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
            if (value) {
                headers.set(key, Array.isArray(value) ? value.join(", ") : value);
            }
        }

        const webRequest = new Request(url.href, {
            method: req.method,
            headers,
            body: req.method !== "GET" && req.method !== "HEAD" && parsedBody !== undefined
                ? JSON.stringify(parsedBody)
                : undefined,
        });

        const webResponse = await transport.handleRequest(webRequest, { parsedBody });

        // Convert Web Standard Response to Node.js ServerResponse
        res.statusCode = webResponse.status;
        webResponse.headers.forEach((value, key) => {
            res.setHeader(key, value);
        });

        if (webResponse.body) {
            const reader = webResponse.body.getReader();
            const flushHeaders = true;
            let headersFlushed = false;

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (!headersFlushed && flushHeaders) {
                        res.writeHead(webResponse.status);
                        headersFlushed = true;
                    }
                    const chunk = Buffer.from(value);
                    if (!res.write(chunk)) {
                        // Backpressure — wait for drain
                        await new Promise<void>((resolve) => res.once("drain", resolve));
                    }
                }
            } catch {
                // Client disconnected
            }
            if (!headersFlushed) {
                res.writeHead(webResponse.status);
            }
            res.end();
        } else {
            const text = await webResponse.text();
            res.end(text);
        }
    }

    // ─── Health Endpoint ───────────────────────────────────────────

    private handleHealth(req: IncomingMessage, res: ServerResponse): void {
        if (req.method !== "GET") {
            this.sendJson(res, 405, { error: "Method not allowed" });
            return;
        }

        const memUsage = process.memoryUsage();
        this.sendJson(res, 200, {
            status: "ok",
            timestamp: new Date().toISOString(),
            uptime_ms: Math.round(process.uptime() * 1000),
            http_server: {
                running: true,
                port: this.config.port,
                host: this.config.host,
                active_sessions: this.transports.size,
            },
            memory: {
                heap_used_mb: Math.round(memUsage.heapUsed / 1024 / 1024),
                heap_total_mb: Math.round(memUsage.heapTotal / 1024 / 1024),
                rss_mb: Math.round(memUsage.rss / 1024 / 1024),
            },
        });
    }

    // ─── Status Endpoint ───────────────────────────────────────────

    private handleStatus(req: IncomingMessage, res: ServerResponse): void {
        if (req.method !== "GET") {
            this.sendJson(res, 405, { error: "Method not allowed" });
            return;
        }

        const stats = this.getStats();
        const memUsage = process.memoryUsage();

        this.sendJson(res, 200, {
            server: {
                name: "quill-mcp",
                version: "1.0.0",
                node_version: process.version,
                platform: process.platform,
            },
            http: stats,
            process: {
                uptime_ms: Math.round(process.uptime() * 1000),
                memory: {
                    heap_used_mb: Math.round(memUsage.heapUsed / 1024 / 1024),
                    heap_total_mb: Math.round(memUsage.heapTotal / 1024 / 1024),
                    rss_mb: Math.round(memUsage.rss / 1024 / 1024),
                    external_mb: Math.round(memUsage.external / 1024 / 1024),
                },
            },
        });
    }

    // ─── Tools Endpoint ────────────────────────────────────────────

    private async handleTools(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (req.method !== "GET") {
            this.sendJson(res, 405, { error: "Method not allowed" });
            return;
        }

        try {
            // Access registered tools from McpServer's internal store
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const registeredTools = (this.mcpServer as any)._registeredTools as Record<
                string,
                { description?: string; inputSchema?: unknown; enabled?: boolean; title?: string }
            >;

            const tools = Object.entries(registeredTools)
                .filter(([, tool]) => tool.enabled !== false)
                .map(([toolName, tool]) => ({
                    name: toolName,
                    title: tool.title,
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                }));

            this.sendJson(res, 200, {
                tools,
                count: tools.length,
            });
        } catch (err) {
            this.totalErrors++;
            this.sendJson(res, 500, {
                error: "Failed to list tools",
                details: err instanceof Error ? err.message : String(err),
            });
        }
    }

    // ─── Authentication ────────────────────────────────────────────

    private checkAuth(req: IncomingMessage): boolean {
        if (!this.config.authToken) {
            return true; // No auth configured
        }

        const authHeader = req.headers.authorization;
        if (!authHeader) {
            return false;
        }

        // Support "Bearer <token>" format
        const parts = authHeader.split(" ");
        if (parts.length !== 2 || parts[0] !== "Bearer") {
            return false;
        }

        return parts[1] === this.config.authToken;
    }

    // ─── CORS ──────────────────────────────────────────────────────

    private setCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
        const origins = this.config.corsOrigins;
        if (!origins || origins.length === 0) {
            return;
        }

        const origin = req.headers.origin;
        if (origin && origins.includes(origin)) {
            res.setHeader("Access-Control-Allow-Origin", origin);
            res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
            res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, Last-Event-Id");
            res.setHeader("Access-Control-Max-Age", "86400");
        }
    }

    private handleCorsPreflight(req: IncomingMessage, res: ServerResponse): void {
        this.setCorsHeaders(req, res);
        res.statusCode = 204;
        res.end();
    }

    // ─── Rate Limiting ─────────────────────────────────────────────

    private checkRateLimit(req: IncomingMessage): boolean {
        const ip = req.socket.remoteAddress || "unknown";
        const now = Date.now();

        let entry = this.ipRates.get(ip);
        if (!entry || now >= entry.resetAt) {
            entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
            this.ipRates.set(ip, entry);
        }

        entry.count++;
        return entry.count <= DEFAULT_RATE_LIMIT;
    }

    private cleanupRateLimits(): void {
        const now = Date.now();
        for (const [ip, entry] of this.ipRates) {
            if (now >= entry.resetAt) {
                this.ipRates.delete(ip);
            }
        }
    }

    // ─── Helpers ───────────────────────────────────────────────────

    private readBody(req: IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            let size = 0;

            req.on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > MAX_REQUEST_SIZE) {
                    reject(new Error("Request body too large (max 10MB)"));
                    req.destroy();
                    return;
                }
                chunks.push(chunk);
            });

            req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
            req.on("error", reject);
        });
    }

    private sendJson(res: ServerResponse, status: number, data: unknown): void {
        const body = JSON.stringify(data);
        res.setHeader("Content-Type", "application/json");
        res.statusCode = status;
        res.end(body);
    }

    private logRequest(req: IncomingMessage, status: number, durationMs: number): void {
        logger.debug("HTTP request", {
            method: req.method,
            path: req.url,
            status,
            duration_ms: durationMs,
            ip: req.socket.remoteAddress,
        });
    }
}

// ─── Configuration Resolution ──────────────────────────────────────────

/**
 * Resolve HTTP server configuration from config file, environment variables,
 * and CLI arguments. Priority: CLI args > env vars > config file > defaults.
 */
export function resolveHttpConfig(fileConfig?: Record<string, unknown>): HttpServerConfig {
    const defaults: HttpServerConfig = {
        enabled: false,
        port: 3000,
        host: "127.0.0.1",
    };

    // Layer 1: config file
    const httpConfig = (fileConfig?.http as Record<string, unknown>) || {};
    let config: HttpServerConfig = {
        enabled: (httpConfig.enabled as boolean) ?? defaults.enabled,
        port: (httpConfig.port as number) ?? defaults.port,
        host: (httpConfig.host as string) ?? defaults.host,
        authToken: httpConfig.auth_token as string | undefined,
        corsOrigins: httpConfig.cors_origins as string[] | undefined,
    };

    // Layer 2: environment variables
    if (process.env.QUILL_HTTP_ENABLED !== undefined) {
        config.enabled = process.env.QUILL_HTTP_ENABLED === "true" || process.env.QUILL_HTTP_ENABLED === "1";
    }
    if (process.env.QUILL_HTTP_PORT !== undefined) {
        const port = parseInt(process.env.QUILL_HTTP_PORT, 10);
        if (!isNaN(port) && port > 0 && port < 65536) {
            config.port = port;
        }
    }
    if (process.env.QUILL_HTTP_HOST !== undefined) {
        config.host = process.env.QUILL_HTTP_HOST;
    }
    if (process.env.QUILL_AUTH_TOKEN !== undefined) {
        config.authToken = process.env.QUILL_AUTH_TOKEN;
    }

    // Layer 3: CLI arguments
    const args = process.argv.slice(2);
    if (args.includes("--http")) {
        config.enabled = true;
    }
    const portIdx = args.indexOf("--port");
    if (portIdx !== -1 && args[portIdx + 1]) {
        const port = parseInt(args[portIdx + 1], 10);
        if (!isNaN(port) && port > 0 && port < 65536) {
            config.port = port;
        }
    }
    const hostIdx = args.indexOf("--host");
    if (hostIdx !== -1 && args[hostIdx + 1]) {
        config.host = args[hostIdx + 1];
    }
    const tokenIdx = args.indexOf("--auth-token");
    if (tokenIdx !== -1 && args[tokenIdx + 1]) {
        config.authToken = args[tokenIdx + 1];
    }

    // Security: warn if binding to non-localhost without auth
    if (config.enabled && config.host !== "127.0.0.1" && config.host !== "localhost" && !config.authToken) {
        logger.warn("HTTP server binding to non-localhost without auth token. " +
            "Set QUILL_AUTH_TOKEN or auth_token in config for secure access.");
    }

    return config;
}
