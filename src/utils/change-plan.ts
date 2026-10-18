/**
 * Change plan system for safe, previewable, transactional vault operations.
 *
 * A change plan is a sequence of proposed operations with pre-conditions
 * (content hashes at plan time). Before applying, we verify that no affected
 * file has changed since the plan was created. If any file changed, the plan
 * is rejected — the agent must re-preview.
 *
 * Plans are stored in-memory and expire after a configurable TTL.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolveVaultPath, pathExists } from "./vault.js";

export type PlanOperation =
    | "write"
    | "append"
    | "delete"
    | "move"
    | "create_folder"
    | "delete_folder";

export interface PlanStep {
    /** The operation to perform */
    op: PlanOperation;
    /** Target path (relative to vault root) */
    path: string;
    /** For move: destination path */
    dest_path?: string;
    /** Content hash at plan creation time (for write/append targets that exist) */
    content_hash?: string;
    /** New content (for write) or content to append */
    content?: string;
    /** Human-readable description of what this step does */
    description: string;
}

export interface ChangePlan {
    id: string;
    created: string;
    description: string;
    steps: PlanStep[];
    /** ISO timestamp when the plan expires */
    expires: string;
    /** Whether the plan has been applied */
    applied: boolean;
}

/** In-memory plan store */
const plans = new Map<string, ChangePlan>();

/** How long plans stay valid (30 minutes) */
const PLAN_TTL_MS = 30 * 60_000;

/** Maximum plans stored (prevent memory growth) */
const MAX_PLANS = 50;

/**
 * Compute a SHA-256 hash of file content for change detection.
 */
export function hashContent(content: string): string {
    return createHash("sha256").update(content, "utf-8").digest("hex").slice(0, 16);
}

/**
 * Create a new change plan from a list of proposed steps.
 * Automatically captures content hashes for existing files.
 */
export async function createPlan(
    description: string,
    steps: PlanStep[],
): Promise<ChangePlan> {
    // Capture content hashes for all target files that exist
    for (const step of steps) {
        const fullPath = resolveVaultPath(step.path.endsWith(".md") ? step.path : `${step.path}.md`);
        if (await pathExists(fullPath)) {
            try {
                const content = await readFile(fullPath, "utf-8");
                step.content_hash = hashContent(content);
            } catch {
                // File may be unreadable; skip hash
            }
        }
    }

    // Enforce max plans
    if (plans.size >= MAX_PLANS) {
        const oldest = plans.keys().next().value;
        if (oldest) plans.delete(oldest);
    }

    const plan: ChangePlan = {
        id: randomUUID().slice(0, 8),
        created: new Date().toISOString(),
        description,
        steps,
        expires: new Date(Date.now() + PLAN_TTL_MS).toISOString(),
        applied: false,
    };

    plans.set(plan.id, plan);
    return plan;
}

/**
 * Get a plan by ID. Returns null if not found or expired.
 */
export function getPlan(planId: string): ChangePlan | null {
    const plan = plans.get(planId);
    if (!plan) return null;

    if (new Date(plan.expires) < new Date()) {
        plans.delete(planId);
        return null;
    }

    return plan;
}

/**
 * List all active (non-expired, non-applied) plans.
 */
export function listPlans(): { id: string; description: string; steps: number; created: string; expires: string }[] {
    const now = new Date();
    const result: { id: string; description: string; steps: number; created: string; expires: string }[] = [];

    for (const [id, plan] of plans) {
        if (new Date(plan.expires) < now || plan.applied) {
            plans.delete(id);
            continue;
        }
        result.push({
            id: plan.id,
            description: plan.description,
            steps: plan.steps.length,
            created: plan.created,
            expires: plan.expires,
        });
    }

    return result;
}

/**
 * Validate that no file in the plan has changed since creation.
 * Returns { valid: true } or { valid: false, conflicts: [...] }.
 */
export async function validatePlan(planId: string): Promise<{
    valid: boolean;
    conflicts: { path: string; reason: string }[];
    plan: ChangePlan | null;
}> {
    const plan = getPlan(planId);
    if (!plan) {
        return { valid: false, conflicts: [{ path: "(plan)", reason: "Plan not found or expired" }], plan: null };
    }

    if (plan.applied) {
        return { valid: false, conflicts: [{ path: "(plan)", reason: "Plan already applied" }], plan };
    }

    const conflicts: { path: string; reason: string }[] = [];

    for (const step of plan.steps) {
        const mdPath = step.path.endsWith(".md") ? step.path : `${step.path}.md`;
        const fullPath = resolveVaultPath(mdPath);
        const exists = await pathExists(fullPath);

        if (step.content_hash) {
            // File existed at plan time — verify it hasn't changed
            if (!exists) {
                conflicts.push({ path: step.path, reason: "File was deleted since plan was created" });
                continue;
            }
            try {
                const current = await readFile(fullPath, "utf-8");
                const currentHash = hashContent(current);
                if (currentHash !== step.content_hash) {
                    conflicts.push({ path: step.path, reason: "File content changed since plan was created" });
                }
            } catch {
                conflicts.push({ path: step.path, reason: "File became unreadable" });
            }
        } else if (step.op === "write" || step.op === "append") {
            // File didn't exist at plan time — verify it still doesn't (for write)
            // or that it exists (for append)
            if (step.op === "write" && exists) {
                conflicts.push({ path: step.path, reason: "File was created since plan was created (plan assumed new file)" });
            }
        }
    }

    return { valid: conflicts.length === 0, conflicts, plan };
}

/**
 * Mark a plan as applied.
 */
export function markPlanApplied(planId: string): void {
    const plan = plans.get(planId);
    if (plan) {
        plan.applied = true;
    }
}

/**
 * Delete a plan without applying it.
 */
export function discardPlan(planId: string): void {
    plans.delete(planId);
}

/**
 * Format a plan as human-readable text for preview.
 */
export function formatPlanPreview(plan: ChangePlan): string {
    const lines: string[] = [];
    lines.push(`# Change Plan: ${plan.description}`);
    lines.push(`**Plan ID:** \`${plan.id}\``);
    lines.push(`**Created:** ${plan.created}`);
    lines.push(`**Expires:** ${plan.expires}`);
    lines.push(`**Steps:** ${plan.steps.length}`);
    lines.push("");

    for (let i = 0; i < plan.steps.length; i++) {
        const step = plan.steps[i];
        const hashInfo = step.content_hash ? ` [hash: ${step.content_hash}]` : "";
        lines.push(`${i + 1}. **${step.op}** \`${step.path}\`${step.dest_path ? ` → \`${step.dest_path}\`` : ""}${hashInfo}`);
        lines.push(`   ${step.description}`);
        lines.push("");
    }

    lines.push("---");
    lines.push("To apply this plan, use `apply_change_plan` with plan_id: `" + plan.id + "`");
    lines.push("To discard it, use `apply_change_plan` with plan_id: `" + plan.id + "` and discard: true");

    return lines.join("\n");
}
