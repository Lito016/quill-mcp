#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initVault } from "./utils/vault.js";
import { logger } from "./utils/logger.js";
import type * as z from "zod";

import * as readNote from "./tools/read-note.js";
import * as writeNote from "./tools/write-note.js";
import * as createNote from "./tools/create-note.js";
import * as deleteNote from "./tools/delete-note.js";
import * as moveNote from "./tools/move-note.js";
import * as listNotes from "./tools/list-notes.js";
import * as searchNotes from "./tools/search-notes.js";
import * as noteInfo from "./tools/note-info.js";
import * as createFolder from "./tools/create-folder.js";
import * as appendNote from "./tools/append-note.js";
import * as deleteFolder from "./tools/delete-folder.js";
import * as copyNote from "./tools/copy-note.js";
import * as vaultStatus from "./tools/vault-status.js";
import * as batchDelete from "./tools/batch-delete.js";
import * as batchMove from "./tools/batch-move.js";
import * as renameFolder from "./tools/rename-folder.js";
import * as extractTags from "./tools/extract-tags.js";
import * as searchByName from "./tools/search-by-name.js";
import * as createTemplate from "./tools/create-template.js";
import * as readFrontmatter from "./tools/read-frontmatter.js";
import * as writeFrontmatter from "./tools/write-frontmatter.js";
import * as updateFrontmatter from "./tools/update-frontmatter.js";
import * as extractLinks from "./tools/extract-links.js";
import * as findBacklinks from "./tools/find-backlinks.js";
import * as restoreNote from "./tools/restore-note.js";
import * as listTrash from "./tools/list-trash.js";
import * as watchChanges from "./tools/watch-changes.js";
import * as sessionHistory from "./tools/session-history.js";
import * as extractCallouts from "./tools/extract-callouts.js";
import * as quillWrite from "./tools/quill-write.js";
import * as quillRecordDecision from "./tools/quill-record-decision.js";
import * as quillRecordLesson from "./tools/quill-record-lesson.js";
import * as quillRecordDiscovery from "./tools/quill-record-discovery.js";
import * as quillRetrieve from "./tools/quill-retrieve.js";
import * as quillRecall from "./tools/quill-recall.js";
import * as quillDetectConflicts from "./tools/quill-detect-conflicts.js";
import * as quillResolveConflict from "./tools/quill-resolve-conflict.js";
import * as quillCheckpoint from "./tools/quill-checkpoint.js";
import * as quillRestore from "./tools/quill-restore.js";
import * as quillConsolidate from "./tools/quill-consolidate.js";
import * as quillAudit from "./tools/quill-audit.js";
import * as quillSessionStart from "./tools/quill-session-start.js";
import * as quillSessionEnd from "./tools/quill-session-end.js";
import * as generateHiveCanvas from "./tools/generate-hive-canvas.js";
import * as discover from "./tools/discover.js";
import * as searchFiles from "./tools/search-files.js";
import * as searchByTag from "./tools/search-by-tag.js";
import * as listFolder from "./tools/list-folder.js";
import * as refreshKnowledgeIndex from "./tools/refresh-knowledge-index.js";
import * as vaultGuide from "./tools/vault-guide.js";
import * as healthCheck from "./tools/health-check.js";
import * as graphNeighborhood from "./tools/graph-neighborhood.js";
import * as noteSections from "./tools/note-sections.js";
import * as vaultHealthAudit from "./tools/vault-health-audit.js";
import * as noteUndo from "./tools/note-undo.js";
import * as batchRead from "./tools/batch-read.js";
import * as previewChanges from "./tools/preview-changes.js";
import * as applyChangePlan from "./tools/apply-change-plan.js";
import * as createTask from "./tools/create-task.js";
import * as completeTask from "./tools/complete-task.js";
import * as listTasks from "./tools/list-tasks.js";
import * as queryTasks from "./tools/query-tasks.js";
import * as completeRecurring from "./tools/complete-recurring.js";
import * as listRecurring from "./tools/list-recurring.js";
import * as skipRecurrence from "./tools/skip-recurrence.js";
import * as pauseRecurrence from "./tools/pause-recurrence.js";
import * as resumeRecurrence from "./tools/resume-recurrence.js";
import * as readMemory from "./tools/read-memory.js";
import * as writeMemory from "./tools/write-memory.js";
import * as listMemories from "./tools/list-memories.js";
import * as searchMemories from "./tools/search-memories.js";
import * as deleteMemory from "./tools/delete-memory.js";
import * as linkMemories from "./tools/link-memories.js";
import * as listVersions from "./tools/list-versions.js";
import * as readVersion from "./tools/read-version.js";
import * as restoreVersion from "./tools/restore-version.js";
import * as diffVersions from "./tools/diff-versions.js";
import * as deleteVersion from "./tools/delete-version.js";
import * as subscribeWebhook from "./tools/subscribe-webhook.js";
import * as listWebhooks from "./tools/list-webhooks.js";
import * as deleteWebhook from "./tools/delete-webhook.js";
import * as testWebhook from "./tools/test-webhook.js";
import * as triggerWebhook from "./tools/trigger-webhook.js";
import * as emitEvent from "./tools/emit-event.js";
import * as createBoard from "./tools/create-board.js";
import * as listBoards from "./tools/list-boards.js";
import * as readBoard from "./tools/read-board.js";
import * as moveTaskKanban from "./tools/move-task.js";
import * as addToColumn from "./tools/add-to-column.js";
import * as archiveColumn from "./tools/archive-column.js";
import * as renameColumn from "./tools/rename-column.js";
import * as reorderColumns from "./tools/reorder-columns.js";
import * as semanticSearch from "./tools/semantic-search.js";
import * as findSimilar from "./tools/find-similar.js";
import * as indexVault from "./tools/index-vault.js";
import * as embeddingStatus from "./tools/embedding-status.js";
import * as hybridSearch from "./tools/hybrid-search.js";
import * as hybridSearchSimilar from "./tools/hybrid-search-similar.js";
import * as serverStatus from "./tools/server-status.js";
import { vaultWatcher } from "./utils/watcher.js";
import { webhookManager } from "./utils/webhook-manager.js";
import { classifyError } from "./utils/errors.js";
import { checkRateLimit, startRateLimiterCleanup, stopRateLimiterCleanup } from "./utils/rate-limiter.js";
import { QuillHttpServer, resolveHttpConfig } from "./utils/http-server.js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// --- Crash protection (registered before anything else) ---
process.on("uncaughtException", (err) => {
    logger.error("Uncaught exception", { error: err.message, stack: err.stack });
    // Attempt graceful shutdown but force exit after timeout
    setTimeout(() => {
        logger.error("Forced exit after uncaught exception");
        process.exit(1);
    }, 5000);
});

process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection", { reason: reason instanceof Error ? reason.message : String(reason) });
    // Don't exit on unhandled rejections — just log and continue
});

// --- Safe handler wrapper ---
// Prevents any tool handler from crashing the server process.
// Catches unexpected errors and returns them as MCP error responses
// with structured error data for programmatic client handling.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (...args: any[]) => any;

function safeHandler<H extends AnyHandler>(name: string, handler: H): H {
    const wrapped = async (...args: Parameters<H>) => {
        // Check rate limit before executing handler
        const rateLimitError = checkRateLimit(name);
        if (rateLimitError) {
            return {
                content: [{ type: "text" as const, text: rateLimitError }],
                isError: true,
            };
        }

        try {
            return await handler(...args);
        } catch (err) {
            const classified = classifyError(err);
            logger.error(`Tool "${name}" failed`, { error: classified.message, code: classified.code });
            // Return structured error data as JSON for programmatic client handling
            const errorData = JSON.stringify(classified.data, null, 2);
            return {
                content: [
                    { type: "text" as const, text: `Error in ${name}: ${classified.message}` },
                    { type: "text" as const, text: `Error details:\n${errorData}` },
                ],
                isError: true,
            };
        }
    };
    return wrapped as H;
}

// --- Vault initialization with retry ---
let vaultPath: string;
try {
    vaultPath = initVault();
    logger.info("Vault initialized successfully", { path: vaultPath });
} catch (err) {
    logger.error("Failed to initialize vault", { error: err instanceof Error ? err.message : String(err) });
    // Use a fallback path to prevent complete failure
    vaultPath = process.cwd();
    logger.warn("Using fallback vault path", { path: vaultPath });
}

const server = new McpServer({
    name: "quill-mcp",
    version: "1.0.0",
});

// --- Safe tool registration helper ---
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function registerTool(name: string, description: string, inputSchema: z.ZodObject<any>, handler: AnyHandler) {
    server.registerTool(name, { description, inputSchema }, safeHandler(name, handler));
    toolCount++;
}

let toolCount = 0;

// --- Register all tools ---
registerTool(readNote.name, readNote.description, readNote.inputSchema, readNote.handler);
registerTool(writeNote.name, writeNote.description, writeNote.inputSchema, writeNote.handler);
registerTool(createNote.name, createNote.description, createNote.inputSchema, createNote.handler);
registerTool(deleteNote.name, deleteNote.description, deleteNote.inputSchema, deleteNote.handler);
registerTool(moveNote.name, moveNote.description, moveNote.inputSchema, moveNote.handler);
registerTool(listNotes.name, listNotes.description, listNotes.inputSchema, listNotes.handler);
registerTool(searchNotes.name, searchNotes.description, searchNotes.inputSchema, searchNotes.handler);
registerTool(noteInfo.name, noteInfo.description, noteInfo.inputSchema, noteInfo.handler);
registerTool(createFolder.name, createFolder.description, createFolder.inputSchema, createFolder.handler);
registerTool(appendNote.name, appendNote.description, appendNote.inputSchema, appendNote.handler);
registerTool(deleteFolder.name, deleteFolder.description, deleteFolder.inputSchema, deleteFolder.handler);
registerTool(copyNote.name, copyNote.description, copyNote.inputSchema, copyNote.handler);
registerTool(vaultStatus.name, vaultStatus.description, vaultStatus.inputSchema, vaultStatus.handler);
registerTool(batchDelete.name, batchDelete.description, batchDelete.inputSchema, batchDelete.handler);
registerTool(batchMove.name, batchMove.description, batchMove.inputSchema, batchMove.handler);
registerTool(renameFolder.name, renameFolder.description, renameFolder.inputSchema, renameFolder.handler);
registerTool(extractTags.name, extractTags.description, extractTags.inputSchema, extractTags.handler);
registerTool(searchByName.name, searchByName.description, searchByName.inputSchema, searchByName.handler);
registerTool(createTemplate.name, createTemplate.description, createTemplate.inputSchema, createTemplate.handler);
registerTool(readFrontmatter.name, readFrontmatter.description, readFrontmatter.inputSchema, readFrontmatter.handler);
registerTool(
    writeFrontmatter.name,
    writeFrontmatter.description,
    writeFrontmatter.inputSchema,
    writeFrontmatter.handler,
);
registerTool(
    updateFrontmatter.name,
    updateFrontmatter.description,
    updateFrontmatter.inputSchema,
    updateFrontmatter.handler,
);
registerTool(extractLinks.name, extractLinks.description, extractLinks.inputSchema, extractLinks.handler);
registerTool(findBacklinks.name, findBacklinks.description, findBacklinks.inputSchema, findBacklinks.handler);
registerTool(restoreNote.name, restoreNote.description, restoreNote.inputSchema, restoreNote.handler);
registerTool(listTrash.name, listTrash.description, listTrash.inputSchema, listTrash.handler);
registerTool(watchChanges.name, watchChanges.description, watchChanges.inputSchema, watchChanges.handler);
registerTool(sessionHistory.name, sessionHistory.description, sessionHistory.inputSchema, sessionHistory.handler);
registerTool(extractCallouts.name, extractCallouts.description, extractCallouts.inputSchema, extractCallouts.handler);

// --- Memory Intelligence Tools ---
registerTool(quillWrite.name, quillWrite.description, quillWrite.inputSchema, quillWrite.handler);
registerTool(
    quillRecordDecision.name,
    quillRecordDecision.description,
    quillRecordDecision.inputSchema,
    quillRecordDecision.handler,
);
registerTool(
    quillRecordLesson.name,
    quillRecordLesson.description,
    quillRecordLesson.inputSchema,
    quillRecordLesson.handler,
);
registerTool(
    quillRecordDiscovery.name,
    quillRecordDiscovery.description,
    quillRecordDiscovery.inputSchema,
    quillRecordDiscovery.handler,
);
registerTool(quillRetrieve.name, quillRetrieve.description, quillRetrieve.inputSchema, quillRetrieve.handler);
registerTool(quillRecall.name, quillRecall.description, quillRecall.inputSchema, quillRecall.handler);
registerTool(
    quillDetectConflicts.name,
    quillDetectConflicts.description,
    quillDetectConflicts.inputSchema,
    quillDetectConflicts.handler,
);
registerTool(
    quillResolveConflict.name,
    quillResolveConflict.description,
    quillResolveConflict.inputSchema,
    quillResolveConflict.handler,
);
registerTool(quillCheckpoint.name, quillCheckpoint.description, quillCheckpoint.inputSchema, quillCheckpoint.handler);
registerTool(quillRestore.name, quillRestore.description, quillRestore.inputSchema, quillRestore.handler);
registerTool(
    quillConsolidate.name,
    quillConsolidate.description,
    quillConsolidate.inputSchema,
    quillConsolidate.handler,
);
registerTool(quillAudit.name, quillAudit.description, quillAudit.inputSchema, quillAudit.handler);
registerTool(
    quillSessionStart.name,
    quillSessionStart.description,
    quillSessionStart.inputSchema,
    quillSessionStart.handler,
);
registerTool(quillSessionEnd.name, quillSessionEnd.description, quillSessionEnd.inputSchema, quillSessionEnd.handler);

// --- Hive Canvas Generation ---
registerTool(
    generateHiveCanvas.name,
    generateHiveCanvas.description,
    generateHiveCanvas.inputSchema,
    generateHiveCanvas.handler,
);

// --- Unified Knowledge Discovery ---
registerTool(discover.name, discover.description, discover.inputSchema, discover.handler);
registerTool(searchFiles.name, searchFiles.description, searchFiles.inputSchema, searchFiles.handler);
registerTool(searchByTag.name, searchByTag.description, searchByTag.inputSchema, searchByTag.handler);
registerTool(listFolder.name, listFolder.description, listFolder.inputSchema, listFolder.handler);
registerTool(
    refreshKnowledgeIndex.name,
    refreshKnowledgeIndex.description,
    refreshKnowledgeIndex.inputSchema,
    refreshKnowledgeIndex.handler,
);
registerTool(vaultGuide.name, vaultGuide.description, vaultGuide.inputSchema, vaultGuide.handler);
registerTool(healthCheck.name, healthCheck.description, healthCheck.inputSchema, healthCheck.handler);

// --- Graph-Aware Retrieval ---
registerTool(
    graphNeighborhood.name,
    graphNeighborhood.description,
    graphNeighborhood.inputSchema,
    graphNeighborhood.handler,
);

// --- Section Navigation ---
registerTool(
    noteSections.name,
    noteSections.description,
    noteSections.inputSchema,
    noteSections.handler,
);

// --- Vault Health Auditing ---
registerTool(
    vaultHealthAudit.name,
    vaultHealthAudit.description,
    vaultHealthAudit.inputSchema,
    vaultHealthAudit.handler,
);

// --- Safe Editing (Undo/Redo) ---
registerTool(
    noteUndo.name,
    noteUndo.description,
    noteUndo.inputSchema,
    noteUndo.handler,
);

// --- Batch Operations ---
registerTool(
    batchRead.name,
    batchRead.description,
    batchRead.inputSchema,
    batchRead.handler,
);

// --- Safe Change Plans ---
registerTool(
    previewChanges.name,
    previewChanges.description,
    previewChanges.inputSchema,
    previewChanges.handler,
);
registerTool(
    applyChangePlan.name,
    applyChangePlan.description,
    applyChangePlan.inputSchema,
    applyChangePlan.handler,
);

// --- Task Management ---
registerTool(
    createTask.name,
    createTask.description,
    createTask.inputSchema,
    createTask.handler,
);
registerTool(
    completeTask.name,
    completeTask.description,
    completeTask.inputSchema,
    completeTask.handler,
);
registerTool(
    listTasks.name,
    listTasks.description,
    listTasks.inputSchema,
    listTasks.handler,
);
registerTool(
    queryTasks.name,
    queryTasks.description,
    queryTasks.inputSchema,
    queryTasks.handler,
);

// --- Recurring Tasks ---
registerTool(
    completeRecurring.name,
    completeRecurring.description,
    completeRecurring.inputSchema,
    completeRecurring.handler,
);
registerTool(
    listRecurring.name,
    listRecurring.description,
    listRecurring.inputSchema,
    listRecurring.handler,
);
registerTool(
    skipRecurrence.name,
    skipRecurrence.description,
    skipRecurrence.inputSchema,
    skipRecurrence.handler,
);
registerTool(
    pauseRecurrence.name,
    pauseRecurrence.description,
    pauseRecurrence.inputSchema,
    pauseRecurrence.handler,
);
registerTool(
    resumeRecurrence.name,
    resumeRecurrence.description,
    resumeRecurrence.inputSchema,
    resumeRecurrence.handler,
);

// --- Memory Files ---
registerTool(
    readMemory.name,
    readMemory.description,
    readMemory.inputSchema,
    readMemory.handler,
);
registerTool(
    writeMemory.name,
    writeMemory.description,
    writeMemory.inputSchema,
    writeMemory.handler,
);
registerTool(
    listMemories.name,
    listMemories.description,
    listMemories.inputSchema,
    listMemories.handler,
);
registerTool(
    searchMemories.name,
    searchMemories.description,
    searchMemories.inputSchema,
    searchMemories.handler,
);
registerTool(
    deleteMemory.name,
    deleteMemory.description,
    deleteMemory.inputSchema,
    deleteMemory.handler,
);
registerTool(
    linkMemories.name,
    linkMemories.description,
    linkMemories.inputSchema,
    linkMemories.handler,
);

// --- Note Versioning ---
registerTool(
    listVersions.name,
    listVersions.description,
    listVersions.inputSchema,
    listVersions.handler,
);
registerTool(
    readVersion.name,
    readVersion.description,
    readVersion.inputSchema,
    readVersion.handler,
);
registerTool(
    restoreVersion.name,
    restoreVersion.description,
    restoreVersion.inputSchema,
    restoreVersion.handler,
);
registerTool(
    diffVersions.name,
    diffVersions.description,
    diffVersions.inputSchema,
    diffVersions.handler,
);
registerTool(
    deleteVersion.name,
    deleteVersion.description,
    deleteVersion.inputSchema,
    deleteVersion.handler,
);

// --- Webhook & Event System ---
registerTool(
    subscribeWebhook.name,
    subscribeWebhook.description,
    subscribeWebhook.inputSchema,
    subscribeWebhook.handler,
);
registerTool(
    listWebhooks.name,
    listWebhooks.description,
    listWebhooks.inputSchema,
    listWebhooks.handler,
);
registerTool(
    deleteWebhook.name,
    deleteWebhook.description,
    deleteWebhook.inputSchema,
    deleteWebhook.handler,
);
registerTool(
    testWebhook.name,
    testWebhook.description,
    testWebhook.inputSchema,
    testWebhook.handler,
);
registerTool(
    triggerWebhook.name,
    triggerWebhook.description,
    triggerWebhook.inputSchema,
    triggerWebhook.handler,
);
registerTool(
    emitEvent.name,
    emitEvent.description,
    emitEvent.inputSchema,
    emitEvent.handler,
);

// --- Kanban Board Tools ---
registerTool(
    createBoard.name,
    createBoard.description,
    createBoard.inputSchema,
    createBoard.handler,
);
registerTool(
    listBoards.name,
    listBoards.description,
    listBoards.inputSchema,
    listBoards.handler,
);
registerTool(
    readBoard.name,
    readBoard.description,
    readBoard.inputSchema,
    readBoard.handler,
);
registerTool(
    moveTaskKanban.name,
    moveTaskKanban.description,
    moveTaskKanban.inputSchema,
    moveTaskKanban.handler,
);
registerTool(
    addToColumn.name,
    addToColumn.description,
    addToColumn.inputSchema,
    addToColumn.handler,
);
registerTool(
    archiveColumn.name,
    archiveColumn.description,
    archiveColumn.inputSchema,
    archiveColumn.handler,
);
registerTool(
    renameColumn.name,
    renameColumn.description,
    renameColumn.inputSchema,
    renameColumn.handler,
);
registerTool(
    reorderColumns.name,
    reorderColumns.description,
    reorderColumns.inputSchema,
    reorderColumns.handler,
);

// --- Semantic Search ---
registerTool(
    semanticSearch.name,
    semanticSearch.description,
    semanticSearch.inputSchema,
    semanticSearch.handler,
);
registerTool(
    findSimilar.name,
    findSimilar.description,
    findSimilar.inputSchema,
    findSimilar.handler,
);
registerTool(
    indexVault.name,
    indexVault.description,
    indexVault.inputSchema,
    indexVault.handler,
);
registerTool(
    embeddingStatus.name,
    embeddingStatus.description,
    embeddingStatus.inputSchema,
    embeddingStatus.handler,
);

// --- Hybrid Search ---
registerTool(
    hybridSearch.name,
    hybridSearch.description,
    hybridSearch.inputSchema,
    hybridSearch.handler,
);
registerTool(
    hybridSearchSimilar.name,
    hybridSearchSimilar.description,
    hybridSearchSimilar.inputSchema,
    hybridSearchSimilar.handler,
);

// --- Server Status (HTTP mode monitoring) ---
registerTool(
    serverStatus.name,
    serverStatus.description,
    serverStatus.inputSchema,
    serverStatus.handler,
);

// --- Main ---
async function main() {
    // Resolve HTTP configuration
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    let fileConfig: Record<string, unknown> = {};
    try {
        fileConfig = JSON.parse(readFileSync(resolve(projectRoot, "vault.config.json"), "utf-8"));
    } catch {
        // Config file not found or invalid — use defaults
    }
    const httpConfig = resolveHttpConfig(fileConfig);

    const transport = new StdioServerTransport();
    
    // Connect with retry logic
    let connected = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await server.connect(transport);
            connected = true;
            logger.info(`quill-mcp server running`, { vault: vaultPath, tools: toolCount, attempt });
            break;
        } catch (err) {
            logger.error(`Failed to connect (attempt ${attempt}/3)`, { error: err instanceof Error ? err.message : String(err) });
            if (attempt < 3) {
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            }
        }
    }
    
    if (!connected) {
        logger.error("Failed to connect after 3 attempts — exiting");
        process.exit(1);
    }

    // Initialize file watcher with error handling
    try {
        await vaultWatcher.initialize();
        vaultWatcher.start();
        logger.info("File watcher started");
    } catch (err) {
        logger.error("Failed to start file watcher", { error: err instanceof Error ? err.message : String(err) });
        // Continue without watcher — non-critical
    }

    // Initialize webhook manager with error handling
    try {
        await webhookManager.load();
        webhookManager.startListening();
        logger.info("Webhook manager started");
    } catch (err) {
        logger.error("Failed to start webhook manager", { error: err instanceof Error ? err.message : String(err) });
        // Continue without webhooks — non-critical
    }

    // Start rate limiter cleanup interval
    startRateLimiterCleanup();

    // Start HTTP server if enabled
    let httpServer: QuillHttpServer | null = null;
    if (httpConfig.enabled) {
        try {
            httpServer = new QuillHttpServer(httpConfig, server);
            await httpServer.start();
            // Provide HTTP server reference to server-status tool
            serverStatus.setHttpServerRef(httpServer);
            logger.info("HTTP server enabled", {
                port: httpConfig.port,
                host: httpConfig.host,
                auth: !!httpConfig.authToken,
            });
        } catch (err) {
            logger.error("Failed to start HTTP server", { error: err instanceof Error ? err.message : String(err) });
            // Continue without HTTP — non-critical
        }
    }

    // Keepalive: periodic heartbeat to prevent idle pipe timeouts
    const keepaliveInterval = setInterval(() => {
        logger.debug("keepalive heartbeat");
    }, 60_000); // every 60 seconds

    // Graceful shutdown handler
    async function shutdown(signal: string) {
        clearInterval(keepaliveInterval);
        vaultWatcher.stop();
        webhookManager.stopListening();
        stopRateLimiterCleanup();

        if (httpServer) {
            try {
                await httpServer.stop();
            } catch (err) {
                logger.error("Error stopping HTTP server", { error: err instanceof Error ? err.message : String(err) });
            }
        }

        logger.info(`Received ${signal}, shutting down gracefully`);
        process.exit(0);
    }

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
    logger.error("Fatal error during startup", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
});
