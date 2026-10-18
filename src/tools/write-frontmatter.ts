import { readFile, writeFile } from "node:fs/promises";
import { pathExists, safeWriteTarget, invalidateReadCache } from "../utils/vault.js";
import { invalidateGraphCache } from "../utils/graph-cache.js";
import { parseFrontmatter, stringifyFrontmatter } from "../utils/frontmatter.js";
import * as z from "zod";
import { scheduleHiveRegen } from "./hive-auto-regen.js";

export const name = "write_frontmatter";
export const description = "Write or update YAML frontmatter in a note. Preserves existing content.";
export const inputSchema = z.object({
    path: z.string().describe("Path to the note file, relative to the vault root"),
    frontmatter: z.record(z.unknown()).describe("Frontmatter key-value pairs to write"),
});

export async function handler({ path, frontmatter }: { path: string; frontmatter: Record<string, unknown> }) {
    const fullPath = await safeWriteTarget(path);

    if (!(await pathExists(fullPath))) {
        return { content: [{ type: "text" as const, text: `Error: Note not found at "${path}".` }], isError: true };
    }

    const content = await readFile(fullPath, "utf-8");
    const { content: bodyContent } = parseFrontmatter(content);
    const newFrontmatter = stringifyFrontmatter(frontmatter);
    const newContent = newFrontmatter + bodyContent;

    await writeFile(fullPath, newContent, "utf-8");

    invalidateReadCache(fullPath);
    invalidateGraphCache();
    scheduleHiveRegen(path);
    return { content: [{ type: "text" as const, text: `Frontmatter updated in "${path}".` }] };
}
