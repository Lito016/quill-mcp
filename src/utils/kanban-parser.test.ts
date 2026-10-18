/**
 * Tests for the Kanban board parser utility.
 */
import { describe, it, expect } from "vitest";
import {
    parseBoard,
    serializeBoard,
    buildTaskLine,
    extractDescription,
    extractTags,
    extractPriority,
    extractDueDate,
    findColumn,
    findTask,
    reorderColumns,
    isKanbanContent,
    type KanbanBoard,
    type KanbanColumn,
} from "./kanban-parser.js";

describe("kanban-parser", () => {
    // ─── parseBoard ──────────────────────────────────────────────────

    describe("parseBoard", () => {
        it("parses a basic board with frontmatter", () => {
            const content = `---
type: kanban
columns: [Todo, In Progress, Done]
---
# My Board

## Todo
- [ ] Task 1
- [ ] Task 2

## In Progress
- [ ] Task 3

## Done
- [x] Task 4
`;
            const board = parseBoard(content, "boards/test.md");
            expect(board.name).toBe("My Board");
            expect(board.columns).toHaveLength(3);
            expect(board.columns[0].name).toBe("Todo");
            expect(board.columns[0].tasks).toHaveLength(2);
            expect(board.columns[1].name).toBe("In Progress");
            expect(board.columns[1].tasks).toHaveLength(1);
            expect(board.columns[2].name).toBe("Done");
            expect(board.columns[2].tasks).toHaveLength(1);
        });

        it("parses task completion status", () => {
            const content = `## Todo
- [ ] Pending task

## Done
- [x] Completed task
`;
            const board = parseBoard(content, "test.md");
            expect(board.columns[0].tasks[0].completed).toBe(false);
            expect(board.columns[1].tasks[0].completed).toBe(true);
        });

        it("extracts task metadata (tags, priority, due date)", () => {
            const content = `## Todo
- [ ] Task with tags \u{1F3F7}\u{FE0F} urgent,work
- [ ] Task with priority \u{1F4CC} high
- [ ] Task with due date \u{1F4C5} 2026-10-20
- [ ] Task with all \u{1F3F7}\u{FE0F} urgent \u{1F4CC} high \u{1F4C5} 2026-10-20
`;
            const board = parseBoard(content, "test.md");
            const tasks = board.columns[0].tasks;

            expect(tasks[0].tags).toEqual(["urgent", "work"]);
            expect(tasks[1].priority).toBe("high");
            expect(tasks[2].dueDate).toBe("2026-10-20");
            expect(tasks[3].tags).toEqual(["urgent"]);
            expect(tasks[3].priority).toBe("high");
            expect(tasks[3].dueDate).toBe("2026-10-20");
        });

        it("derives board name from filename when no H1 heading", () => {
            const content = `## Todo
- [ ] Task 1
`;
            const board = parseBoard(content, "boards/my-project.md");
            expect(board.name).toBe("my project");
        });

        it("handles empty columns", () => {
            const content = `## Todo

## In Progress

## Done
`;
            const board = parseBoard(content, "test.md");
            expect(board.columns).toHaveLength(3);
            expect(board.columns[0].tasks).toHaveLength(0);
            expect(board.columns[1].tasks).toHaveLength(0);
            expect(board.columns[2].tasks).toHaveLength(0);
        });

        it("handles board with no columns", () => {
            const content = `# Empty Board
Just some text without any columns.
`;
            const board = parseBoard(content, "test.md");
            expect(board.columns).toHaveLength(0);
        });

        it("supports custom column names", () => {
            const content = `## Backlog
- [ ] Idea 1

## Sprint
- [ ] Work 1

## Review
- [ ] Review 1

## Shipped
- [x] Done 1
`;
            const board = parseBoard(content, "test.md");
            expect(board.columns).toHaveLength(4);
            expect(board.columns.map((c) => c.name)).toEqual(["Backlog", "Sprint", "Review", "Shipped"]);
        });

        it("respects frontmatter column order", () => {
            const content = `---
type: kanban
columns: [Done, Todo, In Progress]
---
## Todo
- [ ] Task 1

## In Progress
- [ ] Task 2

## Done
- [x] Task 3
`;
            const board = parseBoard(content, "test.md");
            expect(board.columns[0].name).toBe("Done");
            expect(board.columns[1].name).toBe("Todo");
            expect(board.columns[2].name).toBe("In Progress");
        });

        it("ignores non-checkbox lines within columns", () => {
            const content = `## Todo
Some description text
- [ ] Task 1
Another note
- [ ] Task 2
`;
            const board = parseBoard(content, "test.md");
            expect(board.columns[0].tasks).toHaveLength(2);
        });

        it("parses X and x as completed", () => {
            const content = `## Done
- [x] Lowercase x
- [X] Uppercase X
`;
            const board = parseBoard(content, "test.md");
            expect(board.columns[0].tasks[0].completed).toBe(true);
            expect(board.columns[0].tasks[1].completed).toBe(true);
        });
    });

    // ─── serializeBoard ──────────────────────────────────────────────

    describe("serializeBoard", () => {
        it("round-trips a basic board", () => {
            const board: KanbanBoard = {
                name: "Test Board",
                columns: [
                    { name: "Todo", tasks: [], index: 0 },
                    { name: "Done", tasks: [], index: 1 },
                ],
                frontmatter: { type: "kanban" },
                filePath: "test.md",
            };

            const content = serializeBoard(board);
            expect(content).toContain("type: kanban");
            expect(content).toContain("# Test Board");
            expect(content).toContain("## Todo");
            expect(content).toContain("## Done");
        });

        it("includes tasks in output", () => {
            const board: KanbanBoard = {
                name: "Test",
                columns: [
                    {
                        name: "Todo",
                        tasks: [
                            {
                                description: "Task 1",
                                completed: false,
                                rawLine: "- [ ] Task 1",
                                lineNum: 1,
                                tags: [],
                                priority: null,
                                dueDate: null,
                            },
                        ],
                        index: 0,
                    },
                ],
                frontmatter: {},
                filePath: "test.md",
            };

            const content = serializeBoard(board);
            expect(content).toContain("- [ ] Task 1");
        });

        it("updates frontmatter columns and timestamp", () => {
            const board: KanbanBoard = {
                name: "Test",
                columns: [
                    { name: "A", tasks: [], index: 0 },
                    { name: "B", tasks: [], index: 1 },
                ],
                frontmatter: { type: "kanban", created: "2026-01-01T00:00:00Z" },
                filePath: "test.md",
            };

            const content = serializeBoard(board);
            expect(content).toContain("columns: [A, B]");
            expect(content).toContain("created: 2026-01-01T00:00:00Z");
            expect(content).toContain("updated:");
        });
    });

    // ─── buildTaskLine ───────────────────────────────────────────────

    describe("buildTaskLine", () => {
        it("builds a basic pending task", () => {
            expect(buildTaskLine("Buy groceries")).toBe("- [ ] Buy groceries");
        });

        it("builds a completed task", () => {
            expect(buildTaskLine("Buy groceries", true)).toBe("- [x] Buy groceries");
        });

        it("includes tags", () => {
            const line = buildTaskLine("Task", false, ["work", "urgent"]);
            expect(line).toContain("\u{1F3F7}\u{FE0F} work,urgent");
        });

        it("includes priority", () => {
            const line = buildTaskLine("Task", false, undefined, "high");
            expect(line).toContain("\u{1F4CC} high");
        });

        it("includes due date", () => {
            const line = buildTaskLine("Task", false, undefined, null, "2026-10-20");
            expect(line).toContain("\u{1F4C5} 2026-10-20");
        });

        it("includes all metadata", () => {
            const line = buildTaskLine("Task", true, ["tag1"], "low", "2026-12-31");
            expect(line).toContain("- [x] Task");
            expect(line).toContain("\u{1F4C5} 2026-12-31");
            expect(line).toContain("\u{1F3F7}\u{FE0F} tag1");
            expect(line).toContain("\u{1F4CC} low");
        });
    });

    // ─── extractDescription ──────────────────────────────────────────

    describe("extractDescription", () => {
        it("strips all metadata emojis", () => {
            const raw = "Buy groceries \u{1F3F7}\u{FE0F} shopping \u{1F4CC} high \u{1F4C5} 2026-10-20";
            expect(extractDescription(raw)).toBe("Buy groceries");
        });

        it("returns plain text unchanged", () => {
            expect(extractDescription("Simple task")).toBe("Simple task");
        });
    });

    // ─── extractTags ─────────────────────────────────────────────────

    describe("extractTags", () => {
        it("extracts comma-separated tags", () => {
            expect(extractTags("Task \u{1F3F7}\u{FE0F} work,urgent")).toEqual(["work", "urgent"]);
        });

        it("returns empty array when no tags", () => {
            expect(extractTags("Simple task")).toEqual([]);
        });
    });

    // ─── extractPriority ─────────────────────────────────────────────

    describe("extractPriority", () => {
        it("extracts high priority", () => {
            expect(extractPriority("Task \u{1F4CC} high")).toBe("high");
        });

        it("extracts medium priority", () => {
            expect(extractPriority("Task \u{1F4CC} medium")).toBe("medium");
        });

        it("extracts low priority", () => {
            expect(extractPriority("Task \u{1F4CC} low")).toBe("low");
        });

        it("returns null when no priority", () => {
            expect(extractPriority("Simple task")).toBeNull();
        });
    });

    // ─── extractDueDate ──────────────────────────────────────────────

    describe("extractDueDate", () => {
        it("extracts a due date", () => {
            expect(extractDueDate("Task \u{1F4C5} 2026-10-20")).toBe("2026-10-20");
        });

        it("returns null when no due date", () => {
            expect(extractDueDate("Simple task")).toBeNull();
        });
    });

    // ─── findColumn ──────────────────────────────────────────────────

    describe("findColumn", () => {
        const board: KanbanBoard = {
            name: "Test",
            columns: [
                { name: "Todo", tasks: [], index: 0 },
                { name: "In Progress", tasks: [], index: 1 },
                { name: "Done", tasks: [], index: 2 },
            ],
            frontmatter: {},
            filePath: "test.md",
        };

        it("finds column by exact name", () => {
            expect(findColumn(board, "Todo")?.name).toBe("Todo");
        });

        it("finds column case-insensitively", () => {
            expect(findColumn(board, "todo")?.name).toBe("Todo");
            expect(findColumn(board, "DONE")?.name).toBe("Done");
        });

        it("returns undefined for missing column", () => {
            expect(findColumn(board, "Nonexistent")).toBeUndefined();
        });
    });

    // ─── findTask ────────────────────────────────────────────────────

    describe("findTask", () => {
        const board: KanbanBoard = {
            name: "Test",
            columns: [
                {
                    name: "Todo",
                    tasks: [
                        {
                            description: "Buy groceries",
                            completed: false,
                            rawLine: "- [ ] Buy groceries",
                            lineNum: 1,
                            tags: [],
                            priority: null,
                            dueDate: null,
                        },
                    ],
                    index: 0,
                },
                {
                    name: "Done",
                    tasks: [
                        {
                            description: "Write report",
                            completed: true,
                            rawLine: "- [x] Write report",
                            lineNum: 2,
                            tags: [],
                            priority: null,
                            dueDate: null,
                        },
                    ],
                    index: 1,
                },
            ],
            frontmatter: {},
            filePath: "test.md",
        };

        it("finds task by partial description", () => {
            const result = findTask(board, "groceries");
            expect(result).toBeDefined();
            expect(result!.task.description).toBe("Buy groceries");
            expect(result!.column.name).toBe("Todo");
        });

        it("searches case-insensitively", () => {
            const result = findTask(board, "REPORT");
            expect(result).toBeDefined();
            expect(result!.task.description).toBe("Write report");
        });

        it("returns undefined for missing task", () => {
            expect(findTask(board, "nonexistent")).toBeUndefined();
        });
    });

    // ─── reorderColumns ──────────────────────────────────────────────

    describe("reorderColumns", () => {
        const columns: KanbanColumn[] = [
            { name: "A", tasks: [], index: 0 },
            { name: "B", tasks: [], index: 1 },
            { name: "C", tasks: [], index: 2 },
        ];

        it("reorders columns", () => {
            const result = reorderColumns(columns, ["C", "A", "B"]);
            expect(result.map((c) => c.name)).toEqual(["C", "A", "B"]);
        });

        it("appends columns not in order list", () => {
            const result = reorderColumns(columns, ["B"]);
            expect(result.map((c) => c.name)).toEqual(["B", "A", "C"]);
        });

        it("re-indexes columns", () => {
            const result = reorderColumns(columns, ["C", "A", "B"]);
            expect(result.map((c) => c.index)).toEqual([0, 1, 2]);
        });

        it("handles case-insensitive matching", () => {
            const result = reorderColumns(columns, ["c", "a", "b"]);
            expect(result.map((c) => c.name)).toEqual(["C", "A", "B"]);
        });
    });

    // ─── isKanbanContent ─────────────────────────────────────────────

    describe("isKanbanContent", () => {
        it("detects frontmatter type: kanban", () => {
            const content = `---
type: kanban
---
## Todo
- [ ] Task
`;
            expect(isKanbanContent(content)).toBe(true);
        });

        it("detects board structure heuristically", () => {
            const content = `## Todo
- [ ] Task 1

## Done
- [x] Task 2
`;
            expect(isKanbanContent(content)).toBe(true);
        });

        it("rejects non-board content", () => {
            const content = `# Regular Note
Some text here.
`;
            expect(isKanbanContent(content)).toBe(false);
        });

        it("rejects single column with tasks", () => {
            const content = `## Todo
- [ ] Task 1
`;
            expect(isKanbanContent(content)).toBe(false);
        });
    });
});
