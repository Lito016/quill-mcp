import { readdir, stat, lstat } from "node:fs/promises";
import { resolveVaultPath, pathExists } from "../utils/vault.js";
import { MAX_PAGINATION_LIMIT } from "../utils/errors.js";
import * as z from "zod";

export const name = "list_notes";
export const description =
    "List notes and folders in a directory. Supports recursive mode, sorting by name/date/size, " +
    "filtering by extension or date, rich output with metadata, and tree view.";
export const inputSchema = z.object({
    path: z.string().default(".").describe("Directory path relative to the vault root (default: root)"),
    recursive: z.boolean().default(false).describe("If true, list all files recursively"),
    limit: z.number().max(MAX_PAGINATION_LIMIT).optional().describe(`Maximum number of entries to return (max ${MAX_PAGINATION_LIMIT})`),
    offset: z.number().default(0).describe("Number of entries to skip (for pagination)"),
    sort: z
        .enum(["name_asc", "name_desc", "date_asc", "date_desc", "size_asc", "size_desc"])
        .default("name_asc")
        .describe("Sort order for results"),
    extension: z.string().optional().describe("Filter by file extension (e.g. '.md', '.canvas')"),
    modified_after: z.string().optional().describe("Only show files modified after this ISO date"),
    modified_before: z.string().optional().describe("Only show files modified before this ISO date"),
    rich: z.boolean().default(false).describe("If true, show file size and modified date alongside each entry"),
    tree: z.boolean().default(false).describe("If true, display as indented tree view"),
});

interface Entry {
    display: string;
    richDisplay: string;
    treeDisplay: string;
    modified: string;
    size: number;
    isDir: boolean;
    relPath: string;
}

export async function handler({
    path,
    recursive,
    limit,
    offset,
    sort,
    extension,
    modified_after,
    modified_before,
    rich,
    tree,
}: {
    path: string;
    recursive: boolean;
    limit?: number;
    offset: number;
    sort: string;
    extension?: string;
    modified_after?: string;
    modified_before?: string;
    rich: boolean;
    tree: boolean;
}) {
    const dirPath = resolveVaultPath(path);

    if (!(await pathExists(dirPath))) {
        return {
            content: [{ type: "text" as const, text: `Error: Directory not found at "${path}".` }],
            isError: true,
        };
    }

    const entries: Entry[] = [];

    async function listDir(dir: string, prefix: string, depth: number) {
        const items = await readdir(dir, { withFileTypes: true });
        for (const item of items) {
            if (item.name === ".trash" || item.name === ".quill-sessions" || item.name === ".versions") continue;
            if (item.name === ".webhooks.json") continue;
            const relPath = prefix ? `${prefix}/${item.name}` : item.name;
            // Symlink defense: never recurse into symbolic links
            const itemStat = await lstat(`${dir}/${item.name}`);
            if (itemStat.isSymbolicLink()) continue;

            if (item.isDirectory()) {
                const treeDisplay = `${"  ".repeat(depth)}📁 ${item.name}/`;
                entries.push({
                    display: `[DIR]  ${relPath}/`,
                    richDisplay: `📁 ${relPath}/`,
                    treeDisplay,
                    modified: "",
                    size: 0,
                    isDir: true,
                    relPath,
                });
                if (recursive) {
                    await listDir(`${dir}/${item.name}`, relPath, depth + 1);
                }
            } else {
                // Extension filter
                if (extension && !item.name.endsWith(extension)) continue;

                // Get file stats for rich output, sorting, and date filtering
                let fileStat: { mtime: Date; size: number } | undefined;
                if (
                    rich ||
                    (sort && sort.startsWith("date")) ||
                    (sort && sort.startsWith("size")) ||
                    modified_after ||
                    modified_before
                ) {
                    try {
                        fileStat = await stat(`${dir}/${item.name}`);
                    } catch {
                        // Skip if stat fails
                    }
                }

                const modified = fileStat ? fileStat.mtime.toISOString() : "";
                const size = fileStat?.size ?? 0;

                // Date filters
                if (modified_after && modified && modified < modified_after) continue;
                if (modified_before && modified && modified > modified_before) continue;

                const dateStr = fileStat ? formatDate(fileStat.mtime) : "";
                const sizeStr = fileStat ? formatSize(fileStat.size) : "";
                const treeDisplay = `${"  ".repeat(depth)}📄 ${item.name}`;

                entries.push({
                    display: `[FILE] ${relPath}`,
                    richDisplay: `📄 ${relPath}  (${sizeStr}, ${dateStr})`,
                    treeDisplay,
                    modified,
                    size,
                    isDir: false,
                    relPath,
                });
            }
        }
    }

    await listDir(dirPath, path === "." ? "" : path, 0);

    if (entries.length === 0) {
        return { content: [{ type: "text" as const, text: "Directory is empty." }] };
    }

    // Sort entries
    entries.sort((a, b) => {
        // Directories always come first
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;

        switch (sort) {
            case "name_desc":
                return b.relPath.localeCompare(a.relPath);
            case "date_asc":
                return (a.modified || "").localeCompare(b.modified || "");
            case "date_desc":
                return (b.modified || "").localeCompare(a.modified || "");
            case "size_asc":
                return a.size - b.size;
            case "size_desc":
                return b.size - a.size;
            default: // name_asc
                return a.relPath.localeCompare(b.relPath);
        }
    });

    const total = entries.length;
    const paginatedEntries = limit ? entries.slice(offset, offset + limit) : entries.slice(offset);

    // Format output
    let output: string;
    if (tree) {
        output = paginatedEntries.map((e) => e.treeDisplay).join("\n");
    } else if (rich) {
        output = paginatedEntries.map((e) => e.richDisplay).join("\n");
    } else {
        output = paginatedEntries.map((e) => e.display).join("\n");
    }

    // Only show pagination info when actually paginating
    const isPaginated = limit !== undefined || offset > 0;
    const prefix = isPaginated ? `Showing ${paginatedEntries.length} of ${total} entries\n\n` : "";

    return { content: [{ type: "text" as const, text: `${prefix}${output}` }] };
}

function formatDate(d: Date): string {
    return d.toISOString().slice(0, 16).replace("T", " ");
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
