import * as z from "zod";
import { resolveVaultPath, pathExists } from "../utils/vault.js";
import { knowledgeIndex, normalizeVaultRelativePath } from "../utils/knowledge-index.js";
import { globToRegExp } from "./search-files.js";

export const name = "search_by_name";
export const description =
    "Search for notes by filename pattern (served from the knowledge index). Supports glob-like matching with * as wildcard (anchored). Plain text does substring matching (no wildcards needed). Internal directories (.trash, .git, .quill-sessions, node_modules) are never matched.";
export const inputSchema = z.object({
    pattern: z
        .string()
        .describe(
            "Filename pattern to match. Use * as wildcard (e.g. 'PRD*' matches PRD.md, PRD_TEMPLATE.md). Plain text matches any filename containing the text.",
        ),
    path: z.string().default(".").describe("Directory to search in, relative to the vault root (default: root)"),
    recursive: z.boolean().default(true).describe("If true, search recursively (default: true)"),
});

export async function handler({ pattern, path, recursive }: { pattern: string; path: string; recursive: boolean }) {
    const dirPath = resolveVaultPath(path);

    if (!(await pathExists(dirPath))) {
        return {
            content: [{ type: "text" as const, text: `Error: Directory not found at "${path}".` }],
            isError: true,
        };
    }

    const safeFolder = normalizeVaultRelativePath(path);
    await knowledgeIndex.ensureSynchronized();

    // If pattern contains *, treat as anchored glob. Otherwise, substring match.
    const isGlob = pattern.includes("*");
    const regex = isGlob ? globToRegExp(pattern) : undefined;
    const needle = pattern.normalize("NFKC").toLocaleLowerCase();
    const prefix = safeFolder === "." ? "" : `${safeFolder}/`;

    const results = knowledgeIndex
        .getEntries(safeFolder)
        .filter((entry) => {
            if (!recursive && entry.path.slice(prefix.length).includes("/")) return false;
            if (regex) return regex.test(entry.filename);
            return entry.filename.normalize("NFKC").toLocaleLowerCase().includes(needle);
        })
        .map((entry) => entry.path);

    if (results.length === 0) {
        return { content: [{ type: "text" as const, text: `No files matching pattern "${pattern}".` }] };
    }

    return { content: [{ type: "text" as const, text: `Found ${results.length} file(s):\n${results.join("\n")}` }] };
}
