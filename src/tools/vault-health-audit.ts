import { readdir, readFile, lstat } from "node:fs/promises";
import { getVaultRoot, resolveVaultPath, pathExists } from "../utils/vault.js";
import { extractLinks } from "../utils/links.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import * as z from "zod";

export const name = "vault_health_audit";
export const description =
    "Comprehensive vault health report. Checks for broken links, orphan notes, duplicate titles, " +
    "missing frontmatter, isolated notes (no links in or out), and empty notes. " +
    "Returns a unified report with severity levels and actionable findings.";

export const inputSchema = z.object({
    checks: z
        .array(
            z.enum([
                "broken_links",
                "orphans",
                "duplicate_titles",
                "missing_frontmatter",
                "isolated_notes",
                "empty_notes",
            ]),
        )
        .optional()
        .describe("Specific checks to run (default: all)"),
    path: z.string().default(".").describe("Directory to audit, relative to vault root (default: root)"),
});

interface Finding {
    severity: "error" | "warning" | "info";
    check: string;
    message: string;
    path?: string;
}

export async function handler({
    checks,
    path,
}: {
    checks?: string[];
    path: string;
}) {
    const dirPath = resolveVaultPath(path);
    if (!(await pathExists(dirPath))) {
        return {
            content: [{ type: "text" as const, text: `Error: Directory not found at "${path}".` }],
            isError: true,
        };
    }

    const allChecks = checks ?? [
        "broken_links",
        "orphans",
        "duplicate_titles",
        "missing_frontmatter",
        "isolated_notes",
        "empty_notes",
    ];

    // Scan all notes
    const vaultRoot = getVaultRoot();
    const notes: { relPath: string; content: string; name: string; title: string | null; hasFrontmatter: boolean; isEmpty: boolean; links: string[] }[] = [];

    async function scanDir(dir: string) {
        const items = await readdir(dir, { withFileTypes: true });
        for (const item of items) {
            if (item.name === ".trash" || item.name === ".quill-sessions" || item.name === ".versions") continue;
            const fullPath = `${dir}/${item.name}`;
            const entryStat = await lstat(fullPath);
            if (entryStat.isSymbolicLink()) continue;
            if (item.isDirectory()) {
                await scanDir(fullPath);
            } else if (item.name.endsWith(".md")) {
                try {
                    const content = await readFile(fullPath, "utf-8");
                    const relPath = fullPath.startsWith(vaultRoot)
                        ? fullPath.slice(vaultRoot.length + 1)
                        : fullPath;
                    const noteName = item.name.replace(/\.md$/, "");
                    const { frontmatter } = parseFrontmatter(content);
                    const title = typeof frontmatter.title === "string" ? frontmatter.title : null;
                    const hasFrontmatter = content.startsWith("---");
                    const bodyContent = content.replace(/^---[\s\S]*?---\s*\n?/, "").trim();
                    const isEmpty = bodyContent.length === 0;
                    const links = extractLinks(content);
                    const linkTargets = [...links.wiki.map((l) => l.target), ...links.markdown.map((l) => l.target)];

                    notes.push({ relPath: relPath.replace(/\\/g, "/"), content, name: noteName, title, hasFrontmatter, isEmpty, links: linkTargets });
                } catch {
                    // Skip unreadable
                }
            }
        }
    }

    await scanDir(dirPath);

    const noteNameSet = new Set(notes.map((n) => n.name.toLowerCase()));
    const findings: Finding[] = [];

    // ── Broken links ──────────────────────────────────────────────────
    if (allChecks.includes("broken_links")) {
        for (const note of notes) {
            for (const target of note.links) {
                const targetName = target.replace(/\.md$/, "").replace(/#.*$/, "").toLowerCase();
                if (targetName && !noteNameSet.has(targetName) && !target.startsWith("http") && !target.startsWith("#")) {
                    findings.push({
                        severity: "error",
                        check: "broken_links",
                        message: `Broken link: [[${target}]] in ${note.relPath}`,
                        path: note.relPath,
                    });
                }
            }
        }
    }

    // ── Orphan notes (no backlinks) ───────────────────────────────────
    if (allChecks.includes("orphans")) {
        const linkedTargets = new Set<string>();
        for (const note of notes) {
            for (const target of note.links) {
                linkedTargets.add(target.replace(/\.md$/, "").replace(/#.*$/, "").toLowerCase());
            }
        }
        for (const note of notes) {
            if (!linkedTargets.has(note.name.toLowerCase())) {
                findings.push({
                    severity: "warning",
                    check: "orphans",
                    message: `Orphan note: no other note links to "${note.relPath}"`,
                    path: note.relPath,
                });
            }
        }
    }

    // ── Duplicate titles ──────────────────────────────────────────────
    if (allChecks.includes("duplicate_titles")) {
        const titleMap = new Map<string, string[]>();
        for (const note of notes) {
            if (note.title) {
                const key = note.title.toLowerCase();
                if (!titleMap.has(key)) titleMap.set(key, []);
                titleMap.get(key)!.push(note.relPath);
            }
        }
        for (const [title, paths] of titleMap) {
            if (paths.length > 1) {
                findings.push({
                    severity: "warning",
                    check: "duplicate_titles",
                    message: `Duplicate title "${title}" in: ${paths.join(", ")}`,
                });
            }
        }
    }

    // ── Missing frontmatter ───────────────────────────────────────────
    if (allChecks.includes("missing_frontmatter")) {
        for (const note of notes) {
            if (!note.hasFrontmatter) {
                findings.push({
                    severity: "info",
                    check: "missing_frontmatter",
                    message: `No frontmatter in "${note.relPath}"`,
                    path: note.relPath,
                });
            }
        }
    }

    // ── Isolated notes (no links in or out) ───────────────────────────
    if (allChecks.includes("isolated_notes")) {
        const linkedTargets = new Set<string>();
        const hasOutgoing = new Set<string>();
        for (const note of notes) {
            for (const target of note.links) {
                linkedTargets.add(target.replace(/\.md$/, "").replace(/#.*$/, "").toLowerCase());
                hasOutgoing.add(note.name.toLowerCase());
            }
        }
        for (const note of notes) {
            const hasIncoming = linkedTargets.has(note.name.toLowerCase());
            const hasOut = hasOutgoing.has(note.name.toLowerCase());
            if (!hasIncoming && !hasOut) {
                findings.push({
                    severity: "info",
                    check: "isolated_notes",
                    message: `Isolated: "${note.relPath}" has no links in or out`,
                    path: note.relPath,
                });
            }
        }
    }

    // ── Empty notes ───────────────────────────────────────────────────
    if (allChecks.includes("empty_notes")) {
        for (const note of notes) {
            if (note.isEmpty) {
                findings.push({
                    severity: "warning",
                    check: "empty_notes",
                    message: `Empty note: "${note.relPath}" has no body content`,
                    path: note.relPath,
                });
            }
        }
    }

    // ── Build report ──────────────────────────────────────────────────
    const errors = findings.filter((f) => f.severity === "error");
    const warnings = findings.filter((f) => f.severity === "warning");
    const infos = findings.filter((f) => f.severity === "info");

    const parts: string[] = [];
    parts.push(`# Vault Health Audit`);
    parts.push(`Scanned: ${notes.length} note(s) in "${path}"`);
    parts.push(`Checks: ${allChecks.join(", ")}`);
    parts.push("");
    parts.push(`## Summary`);
    parts.push(`  Errors:   ${errors.length}`);
    parts.push(`  Warnings: ${warnings.length}`);
    parts.push(`  Info:     ${infos.length}`);
    parts.push(`  Overall:  ${errors.length > 0 ? "NEEDS ATTENTION" : warnings.length > 0 ? "FAIR" : "HEALTHY"}`);
    parts.push("");

    if (errors.length > 0) {
        parts.push(`## Errors (${errors.length})`);
        for (const f of errors) parts.push(`  ✗ ${f.message}`);
        parts.push("");
    }

    if (warnings.length > 0) {
        parts.push(`## Warnings (${warnings.length})`);
        for (const f of warnings.slice(0, 50)) parts.push(`  ⚠ ${f.message}`);
        if (warnings.length > 50) parts.push(`  ... and ${warnings.length - 50} more`);
        parts.push("");
    }

    if (infos.length > 0) {
        parts.push(`## Info (${infos.length})`);
        for (const f of infos.slice(0, 30)) parts.push(`  ℹ ${f.message}`);
        if (infos.length > 30) parts.push(`  ... and ${infos.length - 30} more`);
        parts.push("");
    }

    if (findings.length === 0) {
        parts.push(`No issues found. Vault is healthy!`);
    }

    return { content: [{ type: "text" as const, text: parts.join("\n") }] };
}
