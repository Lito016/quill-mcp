import { resolveVaultPath, pathExists, cachedReadFile } from "../utils/vault.js";
import { parseFrontmatterPartial } from "../utils/frontmatter.js";
import * as z from "zod";

export const name = "batch_read";
export const description =
    "Read multiple notes in a single call. Returns content (or frontmatter-only) for each note. " +
    "Much more efficient than calling read_note repeatedly. " +
    "Supports compact mode (first 500 chars + frontmatter) for quick scanning.";

export const inputSchema = z.object({
    paths: z.array(z.string()).min(1).max(20).describe("List of note paths to read (max 20 to prevent context overflow)"),
    frontmatter_only: z.boolean().default(false).describe("If true, return only frontmatter for each note"),
    compact: z
        .boolean()
        .default(false)
        .describe("If true, return first 500 chars of content + frontmatter (good for quick scanning)"),
    max_chars: z
        .number()
        .min(100)
        .max(10000)
        .optional()
        .describe("Maximum characters per note content (default: 2000 in normal mode, 500 in compact mode)"),
});

export async function handler({
    paths,
    frontmatter_only,
    compact,
    max_chars,
}: {
    paths: string[];
    frontmatter_only: boolean;
    compact: boolean;
    max_chars?: number;
}) {
    const limit = max_chars ?? (compact ? 500 : 2000);
    const results: { path: string; status: string; frontmatter?: Record<string, unknown>; content?: string; chars?: number }[] = [];

    // Read all notes in parallel
    const reads = paths.map(async (p) => {
        const notePath = p.endsWith(".md") ? p : `${p}.md`;
        const fullPath = resolveVaultPath(notePath);

        if (!(await pathExists(fullPath))) {
            return { path: p, status: "not_found" };
        }

        try {
            if (frontmatter_only) {
                const { frontmatter } = await parseFrontmatterPartial(fullPath);
                return { path: p, status: "ok", frontmatter };
            }

            const content = await cachedReadFile(fullPath);
            const truncated = content.length > limit;
            const slice = truncated ? content.slice(0, limit) : content;

            if (compact) {
                const { frontmatter } = await parseFrontmatterPartial(fullPath);
                return { path: p, status: "ok", frontmatter, content: slice, chars: content.length };
            }

            return { path: p, status: "ok", content: slice, chars: content.length };
        } catch {
            return { path: p, status: "error" };
        }
    });

    const settled = await Promise.all(reads);
    results.push(...settled);

    // Build output
    const ok = results.filter((r) => r.status === "ok");
    const notFound = results.filter((r) => r.status === "not_found");
    const errors = results.filter((r) => r.status === "error");

    const parts: string[] = [];
    parts.push(`Batch read: ${ok.length} ok, ${notFound.length} not found, ${errors.length} errors`);
    parts.push("");

    for (const r of results) {
        if (r.status === "not_found") {
            parts.push(`## ${r.path} — NOT FOUND`);
            parts.push("");
            continue;
        }
        if (r.status === "error") {
            parts.push(`## ${r.path} — ERROR`);
            parts.push("");
            continue;
        }

        parts.push(`## ${r.path}`);
        if (r.frontmatter && Object.keys(r.frontmatter).length > 0) {
            parts.push(`Frontmatter: ${JSON.stringify(r.frontmatter)}`);
        }
        if (r.content !== undefined) {
            parts.push(r.content);
            if (r.chars && r.chars > limit) {
                parts.push(`... (truncated, ${r.chars} total chars)`);
            }
        }
        parts.push("");
    }

    return { content: [{ type: "text" as const, text: parts.join("\n") }] };
}
