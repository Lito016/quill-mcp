import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { pathExists, safeWriteTarget, invalidateReadCache, resolveVaultPath } from "../utils/vault.js";
import { relative } from "node:path";
import { getVaultRoot } from "../utils/vault.js";
import { taskIndex, buildTaskLine } from "../utils/task-index.js";
import type { TaskPriority } from "../utils/task-index.js";
import * as z from "zod";

export const name = "create_task";
export const description =
    "Create a new task as a markdown checkbox in a specified note. " +
    "If the note doesn't exist, creates it. Supports due dates, tags, and priority metadata. " +
    "Tasks use standard markdown checkboxes: - [ ] for pending, - [x] for complete.";

export const inputSchema = z.object({
    description: z.string().min(1).max(500).describe("The task description text"),
    note: z
        .string()
        .default("tasks.md")
        .describe("Path to the note file where the task should be added (relative to vault root, default: tasks.md)"),
    due_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Due date in YYYY-MM-DD format"),
    tags: z.array(z.string()).optional().describe("Tags for the task (e.g. ['work', 'urgent'])"),
    priority: z.enum(["high", "medium", "low"]).optional().describe("Task priority level"),
    section: z
        .string()
        .optional()
        .describe("Heading section to add the task under (e.g. 'In Progress'). Creates the heading if missing."),
});

export async function handler({
    description,
    note,
    due_date,
    tags,
    priority,
    section,
}: {
    description: string;
    note: string;
    due_date?: string;
    tags?: string[];
    priority?: "high" | "medium" | "low";
    section?: string;
}) {
    const resolvedPath = extname(note) ? note : `${note}.md`;
    const fullPath = await safeWriteTarget(resolvedPath);
    const vaultRelPath = relative(getVaultRoot(), fullPath).replace(/\\/g, "/");

    const taskLine = buildTaskLine(description, "pending", due_date, tags, priority as TaskPriority);

    let content: string;
    let isNewFile = false;

    if (await pathExists(fullPath)) {
        content = await readFile(fullPath, "utf-8");
    } else {
        isNewFile = true;
        content = "";
    }

    if (section) {
        content = insertTaskInSection(content, section, taskLine);
    } else {
        // Append to end of file
        if (content.length > 0 && !content.endsWith("\n")) {
            content += "\n";
        }
        content += taskLine + "\n";
    }

    // Ensure parent directory exists
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
    invalidateReadCache(fullPath);
    taskIndex.markDirty();

    const location = isNewFile ? `in new note "${resolvedPath}"` : `in "${resolvedPath}"`;
    const sectionInfo = section ? ` under heading "${section}"` : "";
    const metadata: string[] = [];
    if (due_date) metadata.push(`due: ${due_date}`);
    if (tags && tags.length > 0) metadata.push(`tags: ${tags.join(", ")}`);
    if (priority) metadata.push(`priority: ${priority}`);
    const metaStr = metadata.length > 0 ? ` (${metadata.join(", ")})` : "";

    return {
        content: [
            {
                type: "text" as const,
                text: `Task created ${location}${sectionInfo}: "${description}"${metaStr}`,
            },
        ],
    };
}

function insertTaskInSection(content: string, section: string, taskLine: string): string {
    if (content.length === 0) {
        return `## ${section}\n\n${taskLine}\n`;
    }

    const lines = content.split("\n");
    const headingPattern = new RegExp(`^#{1,6}\\s+${escapeRegex(section)}\\s*$`);

    // Find the target heading
    let headingIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        if (headingPattern.test(lines[i].trim())) {
            headingIdx = i;
            break;
        }
    }

    if (headingIdx === -1) {
        // Heading doesn't exist, append it at the end
        if (!content.endsWith("\n")) content += "\n";
        content += `\n## ${section}\n\n${taskLine}\n`;
        return content;
    }

    // Find the heading level
    const headingLevel = lines[headingIdx].match(/^(#{1,6})/)?.[1].length ?? 2;

    // Find insertion point: after the heading, skip blank lines, then find last task or end of section
    let insertIdx = headingIdx + 1;

    // Skip blank lines right after heading
    while (insertIdx < lines.length && lines[insertIdx].trim() === "") {
        insertIdx++;
    }

    // Find end of section (next heading of same or higher level, or EOF)
    let sectionEnd = lines.length;
    for (let i = insertIdx; i < lines.length; i++) {
        const level = lines[i].match(/^(#{1,6})/)?.[1].length ?? 0;
        if (level > 0 && level <= headingLevel) {
            sectionEnd = i;
            break;
        }
    }

    // Insert before the section end
    lines.splice(sectionEnd, 0, taskLine);
    return lines.join("\n");
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
