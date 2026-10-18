import { readdir, readFile, lstat } from "node:fs/promises";
import { resolveVaultPath, pathExists, getVaultRoot } from "../utils/vault.js";
import { extractLinks } from "../utils/links.js";
import * as z from "zod";

export const name = "find_backlinks";
export const description =
    "Find all notes that link to a given note (backlinks). Searches for wiki-style links ([[note]]) and markdown links. " +
    "Supports orphan detection (notes with zero backlinks) and bulk mode for all notes.";
export const inputSchema = z.object({
    path: z
        .string()
        .optional()
        .describe(
            "Path to the target note (without .md extension for wiki links, or with .md for markdown links). Not required for orphan detection.",
        ),
    searchPath: z.string().default(".").describe("Directory to search in, relative to the vault root (default: root)"),
    find_orphans: z.boolean().default(false).describe("If true, find all notes with zero backlinks (isolated notes)"),
});

export async function handler({
    path,
    searchPath,
    find_orphans,
}: {
    path?: string;
    searchPath: string;
    find_orphans: boolean;
}) {
    const dirPath = resolveVaultPath(searchPath);

    if (!(await pathExists(dirPath))) {
        return {
            content: [{ type: "text" as const, text: `Error: Directory not found at "${searchPath}".` }],
            isError: true,
        };
    }

    // Orphan detection mode
    if (find_orphans) {
        return findOrphanNotes(dirPath);
    }

    if (!path) {
        return {
            content: [{ type: "text" as const, text: "Error: 'path' is required unless find_orphans is true." }],
            isError: true,
        };
    }

    // Normalize the target name for matching
    const noteName = path.replace(/\.md$/, "");
    const notePathWithExt = path.endsWith(".md") ? path : `${path}.md`;

    const backlinks: { file: string; line: number; context: string; type: "wiki" | "markdown" }[] = [];

    async function searchDir(dir: string) {
        const items = await readdir(dir, { withFileTypes: true });
        for (const item of items) {
            const fullPath = `${dir}/${item.name}`;
            // Symlink defense: never recurse into symbolic links
            const itemStat = await lstat(fullPath);
            if (itemStat.isSymbolicLink()) continue;
            if (item.isDirectory()) {
                await searchDir(fullPath);
            } else if (item.name.endsWith(".md")) {
                try {
                    const content = await readFile(fullPath, "utf-8");
                    const lines = content.split("\n");
                    const relPath = fullPath.startsWith(getVaultRoot())
                        ? fullPath.slice(getVaultRoot().length + 1)
                        : fullPath;

                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i];

                        // Check for wiki-style backlinks: [[target]] or [[target|...]]
                        const wikiRegex = new RegExp(`\\[\\[${escapeRegex(noteName)}(?:\\|[^\\]]+)?\\]\\]`, "g");
                        if (wikiRegex.test(line)) {
                            backlinks.push({ file: relPath, line: i + 1, context: line.trim(), type: "wiki" });
                        }

                        // Check for markdown backlinks: [text](target.md)
                        const mdRegex = new RegExp(
                            `\\[([^\\]]+)\\]\\(${escapeRegex(notePathWithExt)}(?:#[^)]*)?\\)`,
                            "g",
                        );
                        if (mdRegex.test(line)) {
                            backlinks.push({ file: relPath, line: i + 1, context: line.trim(), type: "markdown" });
                        }
                    }
                } catch {
                    // Skip unreadable files
                }
            }
        }
    }

    await searchDir(dirPath);

    if (backlinks.length === 0) {
        return { content: [{ type: "text" as const, text: `No backlinks found for "${path}".` }] };
    }

    const wikiLinks = backlinks.filter((b) => b.type === "wiki");
    const mdLinks = backlinks.filter((b) => b.type === "markdown");

    const parts: string[] = [`Found ${backlinks.length} backlink(s) for "${path}":`];

    if (wikiLinks.length > 0) {
        parts.push(`\nWiki-style backlinks (${wikiLinks.length}):`);
        for (const bl of wikiLinks) {
            parts.push(`  ${bl.file}:${bl.line}: ${bl.context}`);
        }
    }

    if (mdLinks.length > 0) {
        parts.push(`\nMarkdown backlinks (${mdLinks.length}):`);
        for (const bl of mdLinks) {
            parts.push(`  ${bl.file}:${bl.line}: ${bl.context}`);
        }
    }

    return { content: [{ type: "text" as const, text: parts.join("\n") }] };
}

/**
 * Find all notes with zero backlinks (orphan notes).
 */
async function findOrphanNotes(dirPath: string): Promise<{ content: { type: "text"; text: string }[] }> {
    const vaultRoot = getVaultRoot();

    // First pass: collect all note names and all link targets
    const allNotes: Map<string, string> = new Map(); // noteName -> fullPath
    const linkedTargets: Set<string> = new Set();

    async function scanDir(dir: string) {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name === ".trash" || entry.name === ".quill-sessions" || entry.name === ".versions") continue;
            const fullPath = `${dir}/${entry.name}`;
            // Symlink defense: never recurse into symbolic links
            const entryStat = await lstat(fullPath);
            if (entryStat.isSymbolicLink()) continue;

            if (entry.isDirectory()) {
                await scanDir(fullPath);
            } else if (entry.name.endsWith(".md")) {
                const relPath = fullPath.startsWith(vaultRoot) ? fullPath.slice(vaultRoot.length + 1) : fullPath;
                const noteName = entry.name.replace(/\.md$/, "");
                allNotes.set(noteName.toLowerCase(), relPath.replace(/\\/g, "/"));

                try {
                    const content = await readFile(fullPath, "utf-8");
                    const links = extractLinks(content);
                    for (const l of links.wiki) {
                        linkedTargets.add(l.target.toLowerCase());
                    }
                } catch {
                    // Skip
                }
            }
        }
    }

    await scanDir(dirPath);

    // Find notes that are never linked to
    const orphans: string[] = [];
    for (const [name, path] of allNotes) {
        if (!linkedTargets.has(name)) {
            orphans.push(path);
        }
    }

    if (orphans.length === 0) {
        return {
            content: [{ type: "text" as const, text: "No orphan notes found. All notes have at least one backlink." }],
        };
    }

    const lines: string[] = [`Found ${orphans.length} orphan note(s) (no backlinks):`];
    for (const p of orphans) {
        lines.push(`  ${p}`);
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
