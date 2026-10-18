import { extname } from "node:path";
import { safeReadTarget } from "../utils/vault.js";
import { parseFrontmatterPartial } from "../utils/frontmatter.js";
import * as z from "zod";

export const name = "read_frontmatter";
export const description =
    "Read and parse YAML frontmatter from a note. Auto-appends .md if no file extension is provided.";
export const inputSchema = z.object({
    path: z.string().describe("Path to the note file, relative to the vault root (.md appended if no extension)"),
});

export async function handler({ path }: { path: string }) {
    // Auto-append .md if no file extension is present
    const resolvedPath = extname(path) ? path : `${path}.md`;
    let fullPath: string;
    try {
        fullPath = await safeReadTarget(resolvedPath);
    } catch {
        return { content: [{ type: "text" as const, text: `Error: Note not found at "${path}".` }], isError: true };
    }

    const { frontmatter } = await parseFrontmatterPartial(fullPath);

    if (Object.keys(frontmatter).length === 0) {
        return { content: [{ type: "text" as const, text: `No frontmatter found in "${path}".` }] };
    }

    return {
        content: [
            { type: "text" as const, text: `Frontmatter for "${path}":\n${JSON.stringify(frontmatter, null, 2)}` },
        ],
    };
}
