import { resolveVaultPath, pathExists } from "../utils/vault.js";
import { createPlan, formatPlanPreview } from "../utils/change-plan.js";
import type { PlanStep } from "../utils/change-plan.js";
import * as z from "zod";

export const name = "preview_changes";
export const description =
    "Preview a set of proposed changes before applying them. Creates a change plan with content hashes. " +
    "Use apply_change_plan to execute the plan after review. " +
    "Supports: write, append, delete, move operations. " +
    "The plan validates that files haven't changed between preview and apply.";

export const inputSchema = z.object({
    description: z.string().describe("Human-readable description of what this change set accomplishes"),
    steps: z
        .array(
            z.object({
                op: z.enum(["write", "append", "delete", "move"]).describe("Operation type"),
                path: z.string().describe("Target note path (relative to vault root)"),
                dest_path: z.string().optional().describe("Destination path (for move operations)"),
                content: z.string().optional().describe("Content to write or append"),
                description: z.string().describe("What this step does"),
            }),
        )
        .min(1)
        .max(100)
        .describe("List of proposed operations (max 100)"),
});

export async function handler({
    description,
    steps,
}: {
    description: string;
    steps: {
        op: "write" | "append" | "delete" | "move";
        path: string;
        dest_path?: string;
        content?: string;
        description: string;
    }[];
}) {
    // Validate steps
    const planSteps: PlanStep[] = [];
    const warnings: string[] = [];

    for (const step of steps) {
        const mdPath = step.path.endsWith(".md") ? step.path : `${step.path}.md`;
        const fullPath = resolveVaultPath(mdPath);
        const exists = await pathExists(fullPath);

        // Validate operation preconditions
        if (step.op === "append" && !exists) {
            warnings.push(`Step "${step.description}": append target "${step.path}" does not exist yet (will fail at apply time)`);
        }
        if (step.op === "delete" && !exists) {
            warnings.push(`Step "${step.description}": delete target "${step.path}" does not exist (will be skipped)`);
        }
        if (step.op === "move" && !exists) {
            warnings.push(`Step "${step.description}": move source "${step.path}" does not exist (will fail at apply time)`);
        }
        if (step.op === "move" && !step.dest_path) {
            return {
                content: [{ type: "text" as const, text: `Error: move operation requires dest_path for "${step.path}".` }],
                isError: true,
            };
        }
        if ((step.op === "write" || step.op === "append") && step.content === undefined) {
            return {
                content: [{ type: "text" as const, text: `Error: ${step.op} operation requires content for "${step.path}".` }],
                isError: true,
            };
        }

        planSteps.push({
            op: step.op,
            path: step.path,
            dest_path: step.dest_path,
            content: step.content,
            description: step.description,
        });
    }

    // Create the plan (captures content hashes)
    const plan = await createPlan(description, planSteps);

    // Format output
    const parts: string[] = [];
    parts.push(formatPlanPreview(plan));

    if (warnings.length > 0) {
        parts.push("");
        parts.push("## Warnings");
        for (const w of warnings) {
            parts.push(`- ⚠ ${w}`);
        }
    }

    // Summary stats
    const opCounts = new Map<string, number>();
    for (const s of planSteps) {
        opCounts.set(s.op, (opCounts.get(s.op) || 0) + 1);
    }
    parts.push("");
    parts.push("## Summary");
    for (const [op, count] of opCounts) {
        parts.push(`- ${op}: ${count}`);
    }

    return { content: [{ type: "text" as const, text: parts.join("\n") }] };
}
