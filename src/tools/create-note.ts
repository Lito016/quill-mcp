import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname, extname, basename } from "node:path";
import { pathExists, safeWriteTarget, safeReadTarget } from "../utils/vault.js";
import { recordMutation } from "../utils/session-tracker.js";
import { parseFrontmatter, stringifyFrontmatter } from "../utils/frontmatter.js";
import { scheduleHiveRegen } from "./hive-auto-regen.js";
import { eventBus } from "../utils/event-bus.js";
import * as z from "zod";

export const name = "create_note";
export const description =
    "Create a new note. Fails if the file already exists. Auto-appends .md if no file extension is provided. " +
    "Supports template scaffolding from vault template files, auto-frontmatter generation, and dry-run preview.";
export const inputSchema = z.object({
    path: z.string().describe("Path to the new note file, relative to the vault root (.md appended if no extension)"),
    content: z.string().default("").describe("The initial content for the note (ignored when template is used)"),
    template: z
        .string()
        .optional()
        .describe("Path to a template file in the vault to use as scaffold (relative to vault root)"),
    auto_frontmatter: z
        .boolean()
        .default(false)
        .describe("If true, auto-generate frontmatter with title, date, and tags"),
    tags: z.array(z.string()).optional().describe("Tags to include in auto-generated frontmatter"),
    dry_run: z.boolean().default(false).describe("If true, preview what would be created without writing"),
});

export async function handler({
    path,
    content,
    template,
    auto_frontmatter,
    tags,
    dry_run,
}: {
    path: string;
    content: string;
    template?: string;
    auto_frontmatter: boolean;
    tags?: string[];
    dry_run: boolean;
}) {
    // Auto-append .md if no file extension is present
    const resolvedPath = extname(path) ? path : `${path}.md`;
    const fullPath = await safeWriteTarget(resolvedPath);

    if (await pathExists(fullPath)) {
        return {
            content: [
                {
                    type: "text" as const,
                    text: `Error: Note already exists at "${resolvedPath}". Use write_note to overwrite.`,
                },
            ],
            isError: true,
        };
    }

    let finalContent = content;

    // Template support: load template from vault (with canonical containment check)
    if (template) {
        const templateRelPath = extname(template) ? template : `${template}.md`;
        let templatePath: string;
        try {
            templatePath = await safeReadTarget(templateRelPath);
        } catch {
            return {
                content: [{ type: "text" as const, text: `Error: Template not found at "${template}".` }],
                isError: true,
            };
        }
        const templateContent = await readFile(templatePath, "utf-8");
        const { content: templateBody } = parseFrontmatter(templateContent);

        // Variable interpolation
        const title = basename(resolvedPath, ".md").replace(/[-_]/g, " ");
        const date = new Date().toISOString().split("T")[0];
        const time = new Date().toISOString().split("T")[1]?.slice(0, 5) ?? "";
        finalContent = templateBody
            .replace(/\{\{title\}\}/g, title)
            .replace(/\{\{date\}\}/g, date)
            .replace(/\{\{time\}\}/g, time)
            .replace(/\{\{path\}\}/g, resolvedPath)
            .replace(/\{\{tags\}\}/g, (tags ?? []).map((t) => `#${t}`).join(" "));
    }

    // Auto-frontmatter generation
    if (auto_frontmatter) {
        const title = basename(resolvedPath, ".md").replace(/[-_]/g, " ");
        const fm: Record<string, unknown> = {
            title,
            date: new Date().toISOString().split("T")[0],
        };
        if (tags && tags.length > 0) {
            fm.tags = tags;
        }
        const fmStr = stringifyFrontmatter(fm);
        // Don't double-add frontmatter if template already has it
        if (!finalContent.startsWith("---")) {
            finalContent = fmStr + "\n" + finalContent;
        }
    }

    // Dry-run mode
    if (dry_run) {
        const preview = finalContent.length > 500 ? finalContent.slice(0, 500) + "\n..." : finalContent;
        return {
            content: [
                {
                    type: "text" as const,
                    text: `[DRY RUN] Would create note at "${resolvedPath}" (${finalContent.length} chars)\n\nContent preview:\n${preview}`,
                },
            ],
        };
    }

    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, finalContent, "utf-8");
    await recordMutation({ type: "create", path: resolvedPath });
    scheduleHiveRegen(resolvedPath);
    eventBus.emitAsync({
        type: "note_created",
        path: resolvedPath,
        timestamp: new Date().toISOString(),
        metadata: { size: Buffer.byteLength(finalContent, "utf-8"), tags: tags ?? [] },
    });
    return { content: [{ type: "text" as const, text: `Note created at "${resolvedPath}".` }] };
}
