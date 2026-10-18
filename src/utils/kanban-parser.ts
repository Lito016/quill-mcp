/**
 * Kanban board parser: parses markdown-based Kanban boards with columns (H2 headings)
 * and tasks (checkbox items). Supports frontmatter metadata and custom column names.
 *
 * Board format:
 * ```markdown
 * ---
 * type: kanban
 * columns: [Todo, In Progress, Done]
 * ---
 * # Board Name
 *
 * ## Todo
 * - [ ] Task 1
 * - [ ] Task 2
 *
 * ## In Progress
 * - [ ] Task 3
 *
 * ## Done
 * - [x] Task 4
 * ```
 */

import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.js";

// ─── Types ────────────────────────────────────────────────────────────

export interface KanbanTask {
    /** The task description text (without checkbox or metadata). */
    description: string;
    /** Whether the checkbox is checked. */
    completed: boolean;
    /** Raw markdown line (trimmed). */
    rawLine: string;
    /** 1-based line number within the file. */
    lineNum: number;
    /** Tags extracted from the task line (from emoji metadata). */
    tags: string[];
    /** Priority level, if specified. */
    priority: "high" | "medium" | "low" | null;
    /** Due date in YYYY-MM-DD format, if present. */
    dueDate: string | null;
}

export interface KanbanColumn {
    /** Column name (from H2 heading). */
    name: string;
    /** Tasks in this column. */
    tasks: KanbanTask[];
    /** 0-based index of the column in the board. */
    index: number;
}

export interface KanbanBoard {
    /** Board name (from H1 heading, or filename). */
    name: string;
    /** Columns in the board, in order. */
    columns: KanbanColumn[];
    /** Frontmatter metadata. */
    frontmatter: Record<string, unknown>;
    /** Vault-relative file path. */
    filePath: string;
}

// ─── Regex Patterns ───────────────────────────────────────────────────

/** Matches H1 heading: `# Board Name` */
const H1_RE = /^# (.+)$/;

/** Matches H2 heading: `## Column Name` */
const H2_RE = /^## (.+)$/;

/** Matches any heading: `# ...` through `###### ...` */
const ANY_HEADING_RE = /^(#{1,6}) (.+)$/;

/** Matches checkbox task line: `- [ ] text` or `- [x] text` */
const TASK_LINE_RE = /^(\s*)- \[([ xX])\] (.+)$/;

/** Tags emoji: 🏷️ tag1,tag2 */
const TAGS_RE = /\u{1F3F7}\u{FE0F}?\s*([\w][\w,\s/-]*)/u;

/** Priority emoji: 📌 high|medium|low */
const PRIORITY_RE = /\u{1F4CC}\s*(high|medium|low)/u;

/** Due date emoji: 📅 YYYY-MM-DD */
const DUE_DATE_RE = /\u{1F4C5}\s*(\d{4}-\d{2}-\d{2})/u;

// ─── Parsing ──────────────────────────────────────────────────────────

/**
 * Parse a Kanban board from markdown content.
 * @param content - The full markdown content of the file
 * @param filePath - Vault-relative file path for identification
 */
export function parseBoard(content: string, filePath: string): KanbanBoard {
    const { frontmatter, content: body } = parseFrontmatter(content);

    // Extract board name from H1 heading or frontmatter
    const lines = body.split("\n");
    let boardName = (frontmatter.title as string) || "";
    let bodyStartIdx = 0;

    for (let i = 0; i < lines.length; i++) {
        const h1Match = lines[i].match(H1_RE);
        if (h1Match) {
            boardName = boardName || h1Match[1].trim();
            bodyStartIdx = i + 1;
            break;
        }
    }

    if (!boardName) {
        // Derive from filename
        const baseName = filePath.split("/").pop() || filePath;
        boardName = baseName.replace(/\.md$/, "").replace(/[-_]/g, " ");
    }

    // Parse columns from H2 headings
    const columns: KanbanColumn[] = [];
    let currentColumn: KanbanColumn | null = null;
    let columnIdx = 0;

    // Use frontmatter columns order if available
    const fmColumns = frontmatter.columns as string[] | undefined;

    for (let i = bodyStartIdx; i < lines.length; i++) {
        const line = lines[i];
        const h2Match = line.match(H2_RE);

        if (h2Match) {
            // Save previous column
            if (currentColumn) {
                columns.push(currentColumn);
            }
            currentColumn = {
                name: h2Match[1].trim(),
                tasks: [],
                index: columnIdx++,
            };
            continue;
        }

        if (currentColumn) {
            const taskMatch = line.match(TASK_LINE_RE);
            if (taskMatch) {
                currentColumn.tasks.push(parseTask(taskMatch, line, i + 1));
            }
        }
    }

    // Push last column
    if (currentColumn) {
        columns.push(currentColumn);
    }

    // If frontmatter specifies columns order, sort and add missing ones
    if (fmColumns && Array.isArray(fmColumns)) {
        const ordered = reorderColumns(columns, fmColumns);
        return { name: boardName, columns: ordered, frontmatter, filePath };
    }

    return { name: boardName, columns, frontmatter, filePath };
}

/**
 * Parse a single task from a regex match result.
 */
function parseTask(match: RegExpMatchArray, rawLine: string, lineNum: number): KanbanTask {
    const completed = match[2].toLowerCase() === "x";
    const rawContent = match[3];

    return {
        description: extractDescription(rawContent),
        completed,
        rawLine: rawLine.trim(),
        lineNum,
        tags: extractTags(rawContent),
        priority: extractPriority(rawContent),
        dueDate: extractDueDate(rawContent),
    };
}

/**
 * Extract clean description text, stripping metadata emojis.
 */
export function extractDescription(rawContent: string): string {
    let desc = rawContent;
    desc = desc.replace(/\s*\u{1F4C5}\s*\d{4}-\d{2}-\d{2}/u, "");
    desc = desc.replace(/\s*\u{1F3F7}\u{FE0F}?\s*[\w][\w,\s/-]*/u, "");
    desc = desc.replace(/\s*\u{1F4CC}\s*(high|medium|low)/u, "");
    return desc.trim();
}

/** Extract tags from a task line. */
export function extractTags(line: string): string[] {
    const match = line.match(TAGS_RE);
    if (!match) return [];
    return match[1]
        .split(/[,\s]+/)
        .map((t) => t.trim())
        .filter(Boolean);
}

/** Extract priority from a task line. */
export function extractPriority(line: string): "high" | "medium" | "low" | null {
    const match = line.match(PRIORITY_RE);
    if (!match) return null;
    return match[1] as "high" | "medium" | "low";
}

/** Extract due date from a task line. */
export function extractDueDate(line: string): string | null {
    const match = line.match(DUE_DATE_RE);
    return match ? match[1] : null;
}

// ─── Serialization ────────────────────────────────────────────────────

/**
 * Serialize a KanbanBoard back to markdown content.
 */
export function serializeBoard(board: KanbanBoard): string {
    const parts: string[] = [];

    // Frontmatter
    const fm = { ...board.frontmatter };
    fm.type = "kanban";
    fm.columns = board.columns.map((c) => c.name);
    fm.updated = new Date().toISOString();
    if (!fm.created) {
        fm.created = new Date().toISOString();
    }
    parts.push(stringifyFrontmatter(fm));

    // Board name
    parts.push(`# ${board.name}\n`);

    // Columns
    for (const col of board.columns) {
        parts.push(`## ${col.name}`);
        if (col.tasks.length === 0) {
            parts.push("");
        } else {
            for (const task of col.tasks) {
                parts.push(task.rawLine);
            }
            parts.push("");
        }
    }

    return parts.join("\n");
}

/**
 * Build a task line from components.
 */
export function buildTaskLine(
    description: string,
    completed: boolean = false,
    tags?: string[],
    priority?: "high" | "medium" | "low" | null,
    dueDate?: string | null,
): string {
    const checkbox = completed ? "[x]" : "[ ]";
    let line = `- ${checkbox} ${description}`;

    if (dueDate) {
        line += ` \u{1F4C5} ${dueDate}`;
    }
    if (tags && tags.length > 0) {
        line += ` \u{1F3F7}\u{FE0F} ${tags.join(",")}`;
    }
    if (priority) {
        line += ` \u{1F4CC} ${priority}`;
    }

    return line;
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Find a column by name (case-insensitive).
 */
export function findColumn(board: KanbanBoard, name: string): KanbanColumn | undefined {
    const lower = name.toLowerCase();
    return board.columns.find((c) => c.name.toLowerCase() === lower);
}

/**
 * Find a task across all columns by description text (case-insensitive partial match).
 * Returns the task and the column it belongs to.
 */
export function findTask(
    board: KanbanBoard,
    searchText: string,
): { task: KanbanTask; column: KanbanColumn } | undefined {
    const lower = searchText.toLowerCase();
    for (const col of board.columns) {
        for (const task of col.tasks) {
            if (task.description.toLowerCase().includes(lower)) {
                return { task, column: col };
            }
        }
    }
    return undefined;
}

/**
 * Find a task by exact raw line match.
 */
export function findTaskByLine(
    board: KanbanBoard,
    rawLine: string,
): { task: KanbanTask; column: KanbanColumn } | undefined {
    const trimmed = rawLine.trim();
    for (const col of board.columns) {
        for (const task of col.tasks) {
            if (task.rawLine === trimmed) {
                return { task, column: col };
            }
        }
    }
    return undefined;
}

/**
 * Reorder columns based on a name array. Columns not in the array
 * are appended at the end. Names are matched case-insensitively.
 */
export function reorderColumns(columns: KanbanColumn[], order: string[]): KanbanColumn[] {
    const result: KanbanColumn[] = [];
    const remaining = [...columns];

    for (const name of order) {
        const lower = name.toLowerCase();
        const idx = remaining.findIndex((c) => c.name.toLowerCase() === lower);
        if (idx !== -1) {
            result.push(remaining.splice(idx, 1)[0]);
        }
    }

    // Append any remaining columns not in the order list
    result.push(...remaining);

    // Re-index
    result.forEach((c, i) => {
        c.index = i;
    });

    return result;
}

/**
 * Check if content looks like a Kanban board (has type: kanban in frontmatter
 * or has multiple H2 sections with checkbox tasks).
 */
export function isKanbanContent(content: string): boolean {
    const { frontmatter } = parseFrontmatter(content);
    if (frontmatter.type === "kanban") return true;

    // Heuristic: at least 2 H2 headings with checkbox items
    const lines = content.split("\n");
    let h2Count = 0;
    let hasCheckbox = false;
    for (const line of lines) {
        if (H2_RE.test(line)) h2Count++;
        if (TASK_LINE_RE.test(line)) hasCheckbox = true;
    }
    return h2Count >= 2 && hasCheckbox;
}
