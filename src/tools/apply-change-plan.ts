import { writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveVaultPath, pathExists, safeWriteTarget, invalidateReadCache } from "../utils/vault.js";
import { invalidateGraphCache } from "../utils/graph-cache.js";
import { validatePlan, markPlanApplied, discardPlan, listPlans } from "../utils/change-plan.js";
import { pushUndo } from "../utils/undo-stack.js";
import { moveToTrash } from "../utils/trash.js";
import * as z from "zod";

export const name = "apply_change_plan";
export const description =
    "Apply a previously created change plan. Validates that no affected file has changed since the plan was created. " +
    "If validation fails, reports which files changed and refuses to apply. " +
    "Use preview_changes first to create a plan. " +
    "Can also list active plans or discard a plan without applying.";

export const inputSchema = z.object({
    plan_id: z.string().optional().describe("Plan ID to apply (from preview_changes output)"),
    action: z
        .enum(["apply", "list", "discard"])
        .default("apply")
        .describe("Action: 'apply' executes the plan, 'list' shows active plans, 'discard' removes a plan"),
});

export async function handler({
    plan_id,
    action = "apply",
}: {
    plan_id?: string;
    action?: "apply" | "list" | "discard";
}) {
    // List mode
    if (action === "list") {
        const active = listPlans();
        if (active.length === 0) {
            return { content: [{ type: "text" as const, text: "No active change plans." }] };
        }
        const lines = ["# Active Change Plans", ""];
        for (const p of active) {
            lines.push(`- **${p.id}**: ${p.description} (${p.steps} steps, expires ${p.expires})`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }

    if (!plan_id) {
        return {
            content: [{ type: "text" as const, text: "Error: plan_id is required for apply/discard actions." }],
            isError: true,
        };
    }

    // Discard mode
    if (action === "discard") {
        discardPlan(plan_id);
        return { content: [{ type: "text" as const, text: `Plan "${plan_id}" discarded.` }] };
    }

    // Apply mode — validate first
    const validation = await validatePlan(plan_id);

    if (!validation.valid) {
        const lines = ["# Plan Validation Failed", ""];
        lines.push(`**Plan ID:** \`${plan_id}\``);
        lines.push("");
        lines.push("## Conflicts");
        for (const c of validation.conflicts) {
            lines.push(`- **${c.path}**: ${c.reason}`);
        }
        lines.push("");
        lines.push("Re-run `preview_changes` to create an updated plan.");
        return { content: [{ type: "text" as const, text: lines.join("\n") }], isError: true };
    }

    const plan = validation.plan!;
    const results: { step: number; op: string; path: string; status: string; error?: string }[] = [];
    let applied = 0;
    let skipped = 0;
    let failed = 0;

    // Apply each step
    for (let i = 0; i < plan.steps.length; i++) {
        const step = plan.steps[i];
        const mdPath = step.path.endsWith(".md") ? step.path : `${step.path}.md`;

        try {
            switch (step.op) {
                case "write": {
                    const fullPath = await safeWriteTarget(mdPath);
                    // Save undo snapshot
                    if (await pathExists(fullPath)) {
                        const { readFile } = await import("node:fs/promises");
                        const current = await readFile(fullPath, "utf-8");
                        pushUndo(fullPath, current, `apply_change_plan step ${i + 1}`);
                    }
                    // Ensure parent directory exists
                    await mkdir(dirname(fullPath), { recursive: true });
                    await writeFile(fullPath, step.content!, "utf-8");
                    invalidateReadCache(fullPath);
                    invalidateGraphCache();
                    results.push({ step: i + 1, op: "write", path: step.path, status: "ok" });
                    applied++;
                    break;
                }
                case "append": {
                    const fullPath = await safeWriteTarget(mdPath);
                    if (!(await pathExists(fullPath))) {
                        results.push({ step: i + 1, op: "append", path: step.path, status: "skipped", error: "File not found" });
                        skipped++;
                        break;
                    }
                    const { readFile, appendFile } = await import("node:fs/promises");
                    const current = await readFile(fullPath, "utf-8");
                    pushUndo(fullPath, current, `apply_change_plan step ${i + 1}`);
                    await appendFile(fullPath, step.content!, "utf-8");
                    invalidateReadCache(fullPath);
                    invalidateGraphCache();
                    results.push({ step: i + 1, op: "append", path: step.path, status: "ok" });
                    applied++;
                    break;
                }
                case "delete": {
                    const fullPath = resolveVaultPath(mdPath);
                    if (!(await pathExists(fullPath))) {
                        results.push({ step: i + 1, op: "delete", path: step.path, status: "skipped", error: "File not found" });
                        skipped++;
                        break;
                    }
                    await moveToTrash(fullPath);
                    invalidateReadCache(fullPath);
                    invalidateGraphCache();
                    results.push({ step: i + 1, op: "delete", path: step.path, status: "ok" });
                    applied++;
                    break;
                }
                case "move": {
                    const srcPath = resolveVaultPath(mdPath);
                    const destMd = step.dest_path!.endsWith(".md") ? step.dest_path! : `${step.dest_path}.md`;
                    const destPath = await safeWriteTarget(destMd);
                    if (!(await pathExists(srcPath))) {
                        results.push({ step: i + 1, op: "move", path: step.path, status: "skipped", error: "Source not found" });
                        skipped++;
                        break;
                    }
                    await mkdir(dirname(destPath), { recursive: true });
                    await rename(srcPath, destPath);
                    invalidateReadCache(srcPath);
                    invalidateReadCache(destPath);
                    invalidateGraphCache();
                    results.push({ step: i + 1, op: "move", path: `${step.path} → ${step.dest_path}`, status: "ok" });
                    applied++;
                    break;
                }
                default:
                    results.push({ step: i + 1, op: step.op, path: step.path, status: "skipped", error: "Unknown operation" });
                    skipped++;
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push({ step: i + 1, op: step.op, path: step.path, status: "failed", error: msg });
            failed++;
        }
    }

    // Mark plan as applied (even if some steps failed)
    markPlanApplied(plan_id);

    // Format output
    const lines = ["# Change Plan Applied", ""];
    lines.push(`**Plan ID:** \`${plan_id}\``);
    lines.push(`**Description:** ${plan.description}`);
    lines.push(`**Results:** ${applied} applied, ${skipped} skipped, ${failed} failed`);
    lines.push("");

    for (const r of results) {
        const icon = r.status === "ok" ? "✓" : r.status === "skipped" ? "⊘" : "✗";
        const errorInfo = r.error ? ` — ${r.error}` : "";
        lines.push(`${icon} ${r.op} \`${r.path}\`${errorInfo}`);
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}
