import { readVersion, listVersions } from "../utils/version-store.js";
import * as z from "zod";

export const name = "diff_versions";
export const description =
    "Compare two versions of a note and return a unified diff. " +
    "Shows added (+), removed (-), and context lines. " +
    "Use list_versions first to see available timestamps.";

export const inputSchema = z.object({
    path: z.string().describe("Path to the note file, relative to the vault root (.md appended if no extension)"),
    from_timestamp: z
        .string()
        .describe("Timestamp of the older version (base). Use 'latest' for the most recent version."),
    to_timestamp: z
        .string()
        .describe("Timestamp of the newer version (target). Use 'latest' for the most recent version."),
    context_lines: z.number().min(0).max(10).default(3).describe("Number of context lines around changes (default: 3)"),
});

export async function handler({
    path,
    from_timestamp,
    to_timestamp,
    context_lines,
}: {
    path: string;
    from_timestamp: string;
    to_timestamp: string;
    context_lines: number;
}) {
    const resolvedPath = path.endsWith(".md") ? path : `${path}.md`;

    // Resolve "latest" to actual latest timestamp
    let fromTs = from_timestamp;
    let toTs = to_timestamp;

    if (fromTs === "latest" || toTs === "latest") {
        const versions = await listVersions(resolvedPath);
        if (versions.length === 0) {
            return {
                content: [{ type: "text" as const, text: `Error: No versions found for "${resolvedPath}".` }],
                isError: true,
            };
        }
        if (fromTs === "latest") fromTs = versions[0].timestamp;
        if (toTs === "latest") toTs = versions.length > 1 ? versions[1].timestamp : versions[0].timestamp;
    }

    const fromResult = await readVersion(resolvedPath, fromTs);
    if (!fromResult) {
        return {
            content: [
                {
                    type: "text" as const,
                    text: `Error: Version not found for "${resolvedPath}" at timestamp "${fromTs}".`,
                },
            ],
            isError: true,
        };
    }

    const toResult = await readVersion(resolvedPath, toTs);
    if (!toResult) {
        return {
            content: [
                {
                    type: "text" as const,
                    text: `Error: Version not found for "${resolvedPath}" at timestamp "${toTs}".`,
                },
            ],
            isError: true,
        };
    }

    const fromLines = fromResult.content.split("\n");
    const toLines = toResult.content.split("\n");

    const diff = computeUnifiedDiff(fromLines, toLines, context_lines);

    if (diff.length === 0) {
        return {
            content: [
                {
                    type: "text" as const,
                    text: `No differences between versions ${fromResult.meta.timestamp} and ${toResult.meta.timestamp}.`,
                },
            ],
        };
    }

    const header = [
        `Diff: "${resolvedPath}"`,
        `From: ${fromResult.meta.timestamp} (${fromResult.meta.reason})`,
        `To:   ${toResult.meta.timestamp} (${toResult.meta.reason})`,
        "",
        ...diff,
    ];

    return { content: [{ type: "text" as const, text: header.join("\n") }] };
}

/**
 * Compute a unified diff between two arrays of lines.
 * Uses a simple LCS-based diff algorithm.
 */
function computeUnifiedDiff(fromLines: string[], toLines: string[], contextLines: number): string[] {
    // Compute LCS table
    const m = fromLines.length;
    const n = toLines.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (fromLines[i - 1] === toLines[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    // Backtrack to get diff operations
    const ops: { type: "equal" | "delete" | "insert"; line: string; fromIdx?: number; toIdx?: number }[] = [];
    let i = m;
    let j = n;

    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && fromLines[i - 1] === toLines[j - 1]) {
            ops.unshift({ type: "equal", line: fromLines[i - 1], fromIdx: i - 1, toIdx: j - 1 });
            i--;
            j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            ops.unshift({ type: "insert", line: toLines[j - 1], toIdx: j - 1 });
            j--;
        } else if (i > 0) {
            ops.unshift({ type: "delete", line: fromLines[i - 1], fromIdx: i - 1 });
            i--;
        }
    }

    // Group into hunks with context
    const hunks: { start: number; ops: typeof ops }[] = [];
    let currentHunk: typeof ops = [];
    let inChange = false;
    let contextBuffer: typeof ops = [];

    for (let k = 0; k < ops.length; k++) {
        const op = ops[k];
        if (op.type !== "equal") {
            // Include preceding context
            if (currentHunk.length === 0) {
                const ctxStart = Math.max(0, k - contextLines);
                for (let c = ctxStart; c < k; c++) {
                    currentHunk.push(ops[c]);
                }
            }
            currentHunk.push(op);
            inChange = true;
            contextBuffer = [];
        } else {
            if (inChange) {
                contextBuffer.push(op);
                if (contextBuffer.length > contextLines) {
                    // End this hunk
                    // Add only contextLines worth of trailing context
                    for (let c = 0; c < contextLines; c++) {
                        currentHunk.push(contextBuffer[c]);
                    }
                    hunks.push({ start: 0, ops: currentHunk });
                    currentHunk = [];
                    inChange = false;
                    contextBuffer = [];
                }
            }
        }
    }

    // Flush remaining hunk
    if (currentHunk.length > 0) {
        for (const ctx of contextBuffer.slice(0, contextLines)) {
            currentHunk.push(ctx);
        }
        hunks.push({ start: 0, ops: currentHunk });
    }

    // Format hunks
    const result: string[] = [];
    for (const hunk of hunks) {
        result.push("@@");
        for (const op of hunk.ops) {
            switch (op.type) {
                case "equal":
                    result.push(` ${op.line}`);
                    break;
                case "delete":
                    result.push(`-${op.line}`);
                    break;
                case "insert":
                    result.push(`+${op.line}`);
                    break;
            }
        }
        result.push("");
    }

    return result;
}
