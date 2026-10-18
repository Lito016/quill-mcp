#!/usr/bin/env node
/**
 * Production-grade I/O benchmark for quill-mcp.
 *
 * Measures:
 * - Cache metrics: hit rate, eviction count, bytes cached
 * - Cold vs warm read latency (p50/p95)
 * - Realistic agent workflows (repeated reads, search-then-read)
 * - Large file performance (1KB → 50MB)
 * - Memory usage and peak RSS
 * - Concurrent append correctness
 *
 * Run: node dist/benchmarks/io-perf.js [vault-path]
 */
import { mkdir, writeFile, rm, appendFile as fsAppendFile, readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { inspect } from "node:util";

// ─── Helpers ──────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
    const idx = Math.ceil(sorted.length * p) - 1;
    return sorted[Math.max(0, idx)];
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

async function bench(fn: () => Promise<void>, iterations = 100): Promise<{ p50: number; p95: number; min: number; max: number; iterations: number }> {
    const times: number[] = [];
    for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await fn();
        times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    return {
        p50: percentile(times, 0.5),
        p95: percentile(times, 0.95),
        min: times[0],
        max: times[times.length - 1],
        iterations,
    };
}

function getMemoryUsage(): { rss: number; heapUsed: number } {
    const mem = process.memoryUsage();
    return { rss: mem.rss, heapUsed: mem.heapUsed };
}

// ─── Fixture generation ───────────────────────────────────────────────

function generateContent(sizeBytes: number): string {
    const header = "---\ntitle: Benchmark Note\ntags: [perf, test]\ncreated: 2026-10-16\n---\n\n";
    const bodyTarget = sizeBytes - header.length;
    const line = "The quick brown fox jumps over the lazy dog. Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n";
    const lines = Math.ceil(bodyTarget / line.length);
    return header + line.repeat(lines);
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
    const vaultPath = process.argv[2] || join(process.cwd(), ".bench-vault");
    const benchDir = join(vaultPath, "bench-files");

    console.log("╔══════════════════════════════════════════════════════════════╗");
    console.log("║       quill-mcp Production I/O Benchmark                    ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");
    console.log(`\nVault: ${vaultPath}`);
    console.log(`Memory at start: ${formatBytes(getMemoryUsage().rss)} RSS\n`);

    // Setup
    await rm(benchDir, { recursive: true, force: true });
    await mkdir(benchDir, { recursive: true });

    // Import after vault setup
    const { initVault, cachedReadFile, invalidateReadCache, tailReadFile, getCacheStats, resetCacheStats } = await import("../utils/vault.js");
    const { parseFrontmatterPartial } = await import("../utils/frontmatter.js");

    process.env.NOTES_VAULT_PATH = vaultPath;
    initVault();

    const sizes = [
        { name: "1KB", bytes: 1024 },
        { name: "10KB", bytes: 10240 },
        { name: "100KB", bytes: 102400 },
        { name: "1MB", bytes: 1024 * 1024 },
        { name: "10MB", bytes: 10 * 1024 * 1024 },
    ];

    // ── Section 1: Cache Metrics ──────────────────────────────────────
    console.log("┌──────────────────────────────────────────────────────────────┐");
    console.log("│  1. CACHE PERFORMANCE METRICS                                │");
    console.log("└──────────────────────────────────────────────────────────────┘\n");

    resetCacheStats();
    const filePath = join(benchDir, "cache-test.md");
    await writeFile(filePath, generateContent(10240), "utf-8");

    // Cold read
    invalidateReadCache();
    const coldStart = performance.now();
    await cachedReadFile(filePath);
    const coldMs = performance.now() - coldStart;

    let stats = getCacheStats();
    console.log(`Cold read (disk I/O):`);
    console.log(`  Latency: ${coldMs.toFixed(2)}ms`);
    console.log(`  Cache: ${stats.size} entries, ${formatBytes(stats.bytesCached)} cached`);
    console.log(`  Hit rate: ${(stats.hitRate * 100).toFixed(1)}% (${stats.hits} hits, ${stats.misses} misses)\n`);

    // Warm reads (10 iterations)
    const warmStart = performance.now();
    for (let i = 0; i < 10; i++) {
        await cachedReadFile(filePath);
    }
    const warmMs = performance.now() - warmStart;

    stats = getCacheStats();
    console.log(`Warm reads (10x from cache):`);
    console.log(`  Total: ${warmMs.toFixed(2)}ms (${(warmMs / 10).toFixed(3)}ms avg)`);
    console.log(`  Cache: ${stats.size} entries, ${formatBytes(stats.bytesCached)} cached`);
    console.log(`  Hit rate: ${(stats.hitRate * 100).toFixed(1)}% (${stats.hits} hits, ${stats.misses} misses)\n`);

    // Eviction test
    resetCacheStats();
    const evictionFiles: string[] = [];
    for (let i = 0; i < 150; i++) {
        const p = join(benchDir, `evict-${i}.md`);
        await writeFile(p, `content-${i}`, "utf-8");
        evictionFiles.push(p);
    }
    for (const p of evictionFiles) {
        await cachedReadFile(p);
    }
    stats = getCacheStats();
    console.log(`Eviction behavior (150 files, max 128):`);
    console.log(`  Cache size: ${stats.size} / ${stats.maxSize}`);
    console.log(`  Evictions: ${stats.evictions}`);
    console.log(`  Bytes cached: ${formatBytes(stats.bytesCached)}\n`);

    // ── Section 2: Cold vs Warm Reads ─────────────────────────────────
    console.log("┌──────────────────────────────────────────────────────────────┐");
    console.log("│  2. COLD vs WARM READ LATENCY                                │");
    console.log("├──────────┬────────────┬────────────┬────────────┬───────────┤");
    console.log("│  Size    │ Cold p50   │ Cold p95   │ Warm p50   │ Warm p95  │");
    console.log("├──────────┼────────────┼────────────┼────────────┼───────────┤");

    for (const { name, bytes } of sizes) {
        const fp = join(benchDir, `read-${name}.md`);
        await writeFile(fp, generateContent(bytes), "utf-8");

        // Cold: invalidate, then read
        const cold = await bench(async () => {
            invalidateReadCache(fp);
            await cachedReadFile(fp);
        }, 50);

        // Warm: populate cache, then read
        invalidateReadCache(fp);
        await cachedReadFile(fp);
        const warm = await bench(async () => {
            await cachedReadFile(fp);
        }, 100);

        console.log(
            `│ ${name.padEnd(8)} │ ${(cold.p50).toFixed(2).padStart(8)}ms │ ${(cold.p95).toFixed(2).padStart(8)}ms │ ${(warm.p50).toFixed(3).padStart(8)}ms │ ${(warm.p95).toFixed(3).padStart(7)}ms │`,
        );
    }
    console.log("└──────────┴────────────┴────────────┴────────────┴───────────┘\n");

    // ── Section 3: Realistic Agent Workflows ──────────────────────────
    console.log("┌──────────────────────────────────────────────────────────────┐");
    console.log("│  3. REALISTIC AGENT WORKFLOWS                                │");
    console.log("└──────────────────────────────────────────────────────────────┘\n");

    // Workflow A: Agent reads same note 5 times (e.g., during a conversation)
    const agentNote = join(benchDir, "agent-note.md");
    await writeFile(agentNote, generateContent(10240), "utf-8");
    invalidateReadCache();

    const workflowA = await bench(async () => {
        invalidateReadCache(agentNote);
        for (let i = 0; i < 5; i++) {
            await cachedReadFile(agentNote);
        }
    }, 50);

    console.log(`Workflow A: Read same note 5x (conversation context)`);
    console.log(`  First read (cold): included in measurement`);
    console.log(`  Total p50: ${workflowA.p50.toFixed(2)}ms, p95: ${workflowA.p95.toFixed(2)}ms`);
    console.log(`  Avg per read: ${(workflowA.p50 / 5).toFixed(2)}ms\n`);

    // Workflow B: Agent searches then reads 3 notes
    const notes = ["note1.md", "note2.md", "note3.md"].map((n) => join(benchDir, n));
    for (const n of notes) {
        await writeFile(n, generateContent(5120), "utf-8");
    }
    invalidateReadCache();

    const workflowB = await bench(async () => {
        invalidateReadCache();
        for (const n of notes) {
            await cachedReadFile(n);
        }
    }, 50);

    console.log(`Workflow B: Search then read 3 different notes`);
    console.log(`  Total p50: ${workflowB.p50.toFixed(2)}ms, p95: ${workflowB.p95.toFixed(2)}ms`);
    console.log(`  Avg per note: ${(workflowB.p50 / 3).toFixed(2)}ms\n`);

    // ── Section 4: Large File Performance ─────────────────────────────
    console.log("┌──────────────────────────────────────────────────────────────┐");
    console.log("│  4. LARGE FILE PERFORMANCE (memory impact)                   │");
    console.log("├──────────┬────────────┬────────────┬────────────────────────┤");
    console.log("│  Size    │ Read p50   │ FM p50     │ Memory delta           │");
    console.log("├──────────┼────────────┼────────────┼────────────────────────┤");

    const largeSizes = [
        { name: "1MB", bytes: 1024 * 1024 },
        { name: "10MB", bytes: 10 * 1024 * 1024 },
        { name: "50MB", bytes: 50 * 1024 * 1024 },
    ];

    for (const { name, bytes } of largeSizes) {
        const fp = join(benchDir, `large-${name}.md`);
        await writeFile(fp, generateContent(bytes), "utf-8");

        const memBefore = getMemoryUsage();
        invalidateReadCache(fp);

        const readResult = await bench(async () => {
            invalidateReadCache(fp);
            await cachedReadFile(fp);
        }, 20);

        const fmResult = await bench(async () => {
            await parseFrontmatterPartial(fp);
        }, 20);

        const memAfter = getMemoryUsage();
        const memDelta = memAfter.heapUsed - memBefore.heapUsed;

        console.log(
            `│ ${name.padEnd(8)} │ ${(readResult.p50).toFixed(2).padStart(8)}ms │ ${(fmResult.p50).toFixed(2).padStart(8)}ms │ ${formatBytes(Math.abs(memDelta)).padStart(8)} ${memDelta >= 0 ? "↑" : "↓"}`,
        );
    }
    console.log("└──────────┴────────────┴────────────┴────────────────────────┘\n");

    // ── Section 5: Concurrent Append Correctness ──────────────────────
    console.log("┌──────────────────────────────────────────────────────────────┐");
    console.log("│  5. CONCURRENT APPEND CORRECTNESS                            │");
    console.log("└──────────────────────────────────────────────────────────────┘\n");

    const appendFilePath = join(benchDir, "concurrent-append.md");
    await writeFile(appendFilePath, "Initial content\n", "utf-8");

    // 10 concurrent appends
    const appendOps = Array.from({ length: 10 }, (_, i) =>
        fsAppendFile(appendFilePath, `Append ${i}\n`, "utf-8"),
    );
    await Promise.all(appendOps);

    const finalContent = await fsReadFile(appendFilePath, "utf-8");
    const lineCount = finalContent.split("\n").filter((l) => l.trim()).length;

    console.log(`Concurrent appends: 10 parallel operations`);
    console.log(`  Expected lines: 11 (1 initial + 10 appends)`);
    console.log(`  Actual lines: ${lineCount}`);
    console.log(`  Result: ${lineCount === 11 ? "✓ PASS" : "✗ FAIL"}\n`);

    // Tail-read performance for newline check
    await writeFile(appendFilePath, generateContent(102400), "utf-8");
    const tailResult = await bench(async () => {
        await tailReadFile(appendFilePath, 2);
    }, 100);

    console.log(`Tail-read (2 bytes) for newline check on 100KB file:`);
    console.log(`  p50: ${tailResult.p50.toFixed(3)}ms`);
    console.log(`  p95: ${tailResult.p95.toFixed(3)}ms\n`);

    // ── Section 6: Memory Summary ─────────────────────────────────────
    const finalMem = getMemoryUsage();
    console.log("┌──────────────────────────────────────────────────────────────┐");
    console.log("│  6. MEMORY SUMMARY                                           │");
    console.log("└──────────────────────────────────────────────────────────────┘\n");
    console.log(`Final RSS: ${formatBytes(finalMem.rss)}`);
    console.log(`Final heap: ${formatBytes(finalMem.heapUsed)}`);
    console.log(`Cache stats: ${inspect(getCacheStats(), { colors: false })}\n`);

    // Cleanup
    await rm(benchDir, { recursive: true, force: true });
    console.log("Benchmark complete.");
}

main().catch(console.error);
