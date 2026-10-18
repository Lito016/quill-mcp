import { resolveVaultPath, pathExists, getVaultRoot, safeWriteTarget } from "../utils/vault.js";
import { scanVaultNotes, VaultNode, VaultEdge } from "../utils/graph.js";
import { extractTags, parseFrontmatter } from "../utils/frontmatter.js";
import { readFile, writeFile, mkdir, stat, readdir } from "node:fs/promises";
import { dirname, relative, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { extractLinks } from "../utils/links.js";
import * as z from "zod";

export const name = "generate_hive_canvas";
export const description =
    "Generate hive.canvas.json from the vault knowledge graph. Classifies notes into core/agent/domain/skill/reference/concept nodes, extracts frontmatter metadata, and writes a canvas-ready JSON file.";

export const inputSchema = z.object({
    output_path: z
        .string()
        .default("canvases/hive.canvas.json")
        .describe("Output path for the canvas JSON, relative to vault root (default: canvases/hive.canvas.json)"),
    scan_path: z
        .string()
        .default("README.md,knowledge,notes,memories,projects,solutions")
        .describe(
            "Comma-separated files or directories to scan, relative to vault root (default: README.md,knowledge,notes,memories,projects,solutions)",
        ),
    include_references: z
        .boolean()
        .default(false)
        .describe(
            "Include deep reference nodes (default: false). These are sub-topic notes inside skill reference folders.",
        ),
});

/* ── colour palette: Graphite console with blue accent ─────────── */

const PALETTE = {
    core: "#2f5fe3", // Primary blue accent
    agent: "#4f7cff", // Lighter blue for agents
    domain: "#374151", // Dark graphite for domains
    skill: "#6b7280", // Medium graphite for skills
    reference: "#9ca3af", // Light graphite for references
    concept: "#64748b", // Slate for concepts
    folder: "#4b5563", // Medium-dark graphite for folder hubs
    status: {
        active: "#10b981", // Green
        warning: "#f59e0b", // Amber
        error: "#ef4444", // Red
    },
};

function colorForKind(kind: CanvasNode["kind"]): string {
    return PALETTE[kind] ?? PALETTE.reference;
}

/* ── types ─────────────────────────────────────────────────────── */

interface CanvasNode {
    id: string;
    label: string;
    short: string;
    kind: "core" | "agent" | "domain" | "folder" | "skill" | "reference" | "concept";
    group: string;
    path: string;
    description: string;
    triggers?: string[];
    size?: "lg" | "md" | "sm"; // Visual size hint for renderer
    importance?: number; // 0-100, guides layout priority
}

interface CanvasLink {
    source: string;
    target: string;
    type: string;
}

interface CanvasData {
    title: string;
    subtitle: string;
    schemaVersion: number;
    groups: { id: string; label: string; color: string }[];
    nodes: CanvasNode[];
    links: CanvasLink[];
    stats: { nodes: number; edges: number; warnings: number };
}

/* ── agent definitions ─────────────────────────────────────────── */

const AGENT_MAP: Record<string, { label: string; short: string; path: string; description: string }> = {
    "prime-problem": {
        label: "Problem",
        short: "P",
        path: "plugin/prime-orchestrator/prime-problem-ideate.md",
        description: "Discover and frame the problem",
    },
    "prime-requirement": {
        label: "Requirement",
        short: "R",
        path: "plugin/prime-orchestrator/prime-requirement-architect.md",
        description: "Turn intent into constraints",
    },
    "prime-instruct": {
        label: "Instruct",
        short: "I",
        path: "plugin/prime-orchestrator/prime-instruct-spec.md",
        description: "Plan implementation and verification",
    },
    "prime-make": {
        label: "Make",
        short: "M",
        path: "plugin/prime-orchestrator/prime-make-build.md",
        description: "Build with domain skills",
    },
    "prime-evaluate": {
        label: "Evaluate",
        short: "E",
        path: "plugin/prime-orchestrator/prime-evaluate-test.md",
        description: "Test, review, and learn",
    },
};

/* ── string helpers ────────────────────────────────────────────── */

function shortName(name: string): string {
    const parts = name.split(/[-_]/);
    if (parts.length === 1) return name.slice(0, 2).toUpperCase();
    return parts
        .map((p) => p[0]?.toUpperCase() ?? "")
        .join("")
        .slice(0, 2);
}

function titleCase(slug: string): string {
    // Handle common acronyms
    const acronyms = new Set([
        "ai",
        "ml",
        "baas",
        "cli",
        "ui",
        "ux",
        "api",
        "css",
        "html",
        "js",
        "ts",
        "db",
        "saas",
        "crm",
        "erp",
    ]);
    return slug
        .split(/[-_]/)
        .map((w) => {
            const lower = w.toLowerCase();
            if (acronyms.has(lower)) return lower.toUpperCase();
            return w.charAt(0).toUpperCase() + w.slice(1);
        })
        .join(" ");
}

/* ── metadata extraction ───────────────────────────────────────── */

async function readNoteMetadata(notePath: string): Promise<{ description: string; triggers: string[] }> {
    try {
        const fullPath = `${getVaultRoot()}/${notePath}`;
        const content = await readFile(fullPath, "utf-8");
        const { frontmatter, content: body } = parseFrontmatter(content);

        const description = (frontmatter.description as string) ?? extractFirstParagraph(body);
        const triggers = Array.isArray(frontmatter.triggers) ? (frontmatter.triggers as unknown[]).map(String) : [];

        return { description, triggers };
    } catch {
        return { description: "", triggers: [] };
    }
}

function extractFirstParagraph(content: string): string {
    const lines = content.split("\n");
    let foundText = false;
    const paragraphs: string[] = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            if (foundText) break;
            continue;
        }
        if (trimmed.startsWith("#")) continue;
        if (trimmed.startsWith("|") || trimmed.startsWith("- ") || trimmed.startsWith("```")) continue;
        foundText = true;
        paragraphs.push(trimmed);
    }
    return paragraphs.join(" ").slice(0, 300);
}

/* ── classification ────────────────────────────────────────────── */

function classifyNote(
    noteId: string,
    _notePath: string,
    skillDirectories: Set<string>,
): { kind: CanvasNode["kind"]; group: string; skillName: string } | null {
    if (noteId === "README") {
        return { kind: "core", group: "core", skillName: "vault" };
    }

    // Core: HIVE-MIND.md
    if (noteId === "plugin/HIVE-MIND") {
        return { kind: "core", group: "core", skillName: "hive-mind" };
    }

    // Skip agent definition files (agents are hardcoded)
    if (noteId.startsWith("plugin/prime-orchestrator/prime-")) {
        return null;
    }

    // Notes directory: decisions, evaluations, changelog
    if (noteId.startsWith("notes/")) {
        const parts = noteId.split("/");
        const subFolder = parts.length > 1 ? parts[1] : "general";
        const fileName = parts[parts.length - 1];
        return { kind: "reference" as const, group: `notes-${subFolder}`, skillName: fileName };
    }

    // Knowledge directory notes
    if (noteId.startsWith("knowledge/")) {
        const fileName = noteId.split("/").pop() ?? noteId;
        return { kind: "reference" as const, group: "knowledge", skillName: fileName };
    }

    if (noteId.startsWith("solutions/")) {
        const fileName = noteId.split("/").pop() ?? noteId;
        return { kind: "reference" as const, group: "solutions", skillName: fileName };
    }

    if (noteId.startsWith("projects/")) {
        const parts = noteId.split("/");
        return { kind: "reference" as const, group: "projects", skillName: parts.slice(1).join("-") };
    }

    if (noteId.startsWith("memories/")) {
        const parts = noteId.split("/");
        const subFolder = parts.length > 1 ? parts[1] : "general";
        const fileName = parts[parts.length - 1];
        return { kind: "reference" as const, group: `memories-${subFolder}`, skillName: fileName };
    }

    // Remaining skill/domain classification is legacy-compatible and only used
    // when callers explicitly include plugin/ in scan_path.
    if (!noteId.startsWith("plugin/")) return null;

    const parts = noteId.split("/");
    if (parts.length < 2) return null;

    const skillDir = parts[1];

    // Skip standalone files in plugin root (not in subdirectories)
    if (parts.length === 2 && skillDir.includes(" ")) return null;

    skillDirectories.add(skillDir);

    const fileName = parts[parts.length - 1];
    const isReference = parts.some((p) => p.endsWith("-references"));

    if (isReference) {
        return { kind: "reference", group: skillDir, skillName: fileName };
    }

    // Domain node: the main skill file (same name as directory)
    if (fileName === skillDir) {
        return { kind: "domain", group: skillDir, skillName: skillDir };
    }

    // Skill node
    return { kind: "skill", group: skillDir, skillName: fileName };
}

/* ── edge classification helper ────────────────────────────────── */

interface EdgeNodeClass {
    kind: "core" | "agent" | "domain" | "folder" | "skill" | "reference" | "concept";
    group: string;
    skillName: string;
}

/* ── agent file → agent key lookup (inverse of AGENT_MAP) ───────── */

const AGENT_FILE_MAP: Record<string, string> = {};
for (const [agentKey, info] of Object.entries(AGENT_MAP)) {
    const fileStub = info.path.replace("plugin/prime-orchestrator/", "").replace(/\.md$/, "");
    AGENT_FILE_MAP[fileStub] = agentKey;
}

function classifyEdgeNode(
    edgeTarget: string,
    nodes: { id: string; path: string }[],
    skillDirectories: Set<string>,
): EdgeNodeClass | null {
    // Check if edge target references a known agent file
    for (const [fileStub, agentKey] of Object.entries(AGENT_FILE_MAP)) {
        if (edgeTarget.includes(fileStub)) {
            return { kind: "agent" as const, group: "prime", skillName: agentKey };
        }
    }

    const exactNode = nodes.find((n) => n.id === edgeTarget);
    if (exactNode) {
        const result = classifyNote(exactNode.id, exactNode.path, skillDirectories);
        if (result) return result;
    }

    const prefixNode = nodes.find((n) => n.id.startsWith(edgeTarget));
    if (prefixNode) {
        const result = classifyNote(prefixNode.id, prefixNode.path, skillDirectories);
        if (result) return result;
    }

    if (edgeTarget && !edgeTarget.startsWith(".") && !edgeTarget.startsWith("http") && !edgeTarget.startsWith("#")) {
        const name = edgeTarget.split("/").pop() ?? edgeTarget;
        return { kind: "concept", group: "concept", skillName: name };
    }

    return null;
}

async function scanSingleNote(fullPath: string): Promise<{ node: VaultNode; edges: VaultEdge[] }> {
    const content = await readFile(fullPath, "utf-8");
    const relPath = relative(getVaultRoot(), fullPath).replace(/\\/g, "/");
    const nodeId = relPath.replace(/\.md$/, "");
    const node: VaultNode = { id: nodeId, path: relPath, tags: extractTags(content) };
    const links = extractLinks(content);
    const edges: VaultEdge[] = [
        ...links.wiki.map((link) => ({
            from: nodeId,
            to: link.target,
            type: "wiki" as const,
            confidence: "EXTRACTED" as const,
        })),
        ...links.markdown.map((link) => ({
            from: nodeId,
            to: link.target.replace(/\.md$/, "").replace(/#.*$/, ""),
            type: "markdown" as const,
            confidence: "EXTRACTED" as const,
        })),
    ];
    return { node, edges };
}

/* ── core generation (exported for auto-regen) ───────────────── */

export async function generateCanvas(
    outputPath = "canvases/hive.canvas.json",
    scanPath = "README.md,knowledge,notes,memories,projects,solutions",
    includeReferences = false,
): Promise<{ nodes: number; links: number; warnings: number; groups: number }> {
    // Support scanning multiple directories
    const scanPaths = scanPath
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    let allNodes: VaultNode[] = [];
    let allEdges: VaultEdge[] = [];

    for (const sp of scanPaths) {
        const scanDir = resolveVaultPath(sp);
        if (!(await pathExists(scanDir))) continue;
        const s = await stat(scanDir);
        if (s.isDirectory()) {
            const { nodes, edges } = await scanVaultNotes(scanDir);
            allNodes = allNodes.concat(nodes);
            allEdges = allEdges.concat(edges);
        } else if (s.isFile() && scanDir.endsWith(".md")) {
            const { node, edges } = await scanSingleNote(scanDir);
            allNodes.push(node);
            allEdges = allEdges.concat(edges);
        }
    }

    if (allNodes.length === 0) {
        return { nodes: 0, links: 0, warnings: 0, groups: 0 };
    }

    // 2. Classify nodes
    const skillDirectories = new Set<string>();
    const canvasNodes: CanvasNode[] = [];
    const nodeIds = new Set<string>();
    let warnings = 0;
    const nodes = allNodes;
    const edges = allEdges;
    const usesPlugin = nodes.some((n) => n.id.startsWith("plugin/"));

    // Core node
    const hiveNode = nodes.find((n) => n.id === "README") ?? nodes.find((n) => n.id === "plugin/HIVE-MIND");
    canvasNodes.push({
        id: "hive",
        label: hiveNode?.id === "plugin/HIVE-MIND" ? "HIVE MIND" : "Vault",
        short: "H",
        kind: "core",
        group: "core",
        path: hiveNode?.path ?? "",
        description:
            hiveNode?.id === "plugin/HIVE-MIND"
                ? "Shared graph memory and routing hub"
                : "Shared vault memory and routing hub",
        size: "lg",
        importance: 100,
    });
    nodeIds.add("hive");

    // Scan top-level vault directories and create folder nodes
    const vaultRoot = getVaultRoot();
    const excludedDirs = new Set([".trash", ".versions", ".embeddings", ".quill", ".quill-sessions", "node_modules", "canvases"]);
    try {
        const vaultEntries = await readdir(vaultRoot, { withFileTypes: true });
        for (const entry of vaultEntries) {
            if (!entry.isDirectory()) continue;
            const dirName = entry.name;
            if (excludedDirs.has(dirName) || dirName.startsWith(".")) continue;
            
            const folderId = `folder:${dirName}`;
            if (nodeIds.has(folderId)) continue;
            nodeIds.add(folderId);
            
            // Count files in directory
            const dirPath = resolve(vaultRoot, dirName);
            let fileCount = 0;
            try {
                const entries = await readdir(dirPath, { withFileTypes: true, recursive: false });
                fileCount = entries.length;
            } catch {
                fileCount = 0;
            }
            
            canvasNodes.push({
                id: folderId,
                label: titleCase(dirName),
                short: shortName(dirName),
                kind: "folder",
                group: dirName.toLowerCase().replace(/[^a-z0-9]/g, "-"),
                path: dirName,
                description: `Vault directory — ${fileCount} items`,
                size: "md",
                importance: 70,
            });
        }
    } catch {
        // If we can't read vault root, skip folder scanning
    }

    // Agent nodes
    if (usesPlugin) {
        for (const [agentKey, info] of Object.entries(AGENT_MAP)) {
            const agentId = `agent:${agentKey.replace("prime-", "")}`;
            canvasNodes.push({
                id: agentId,
                label: info.label,
                short: info.short,
                kind: "agent",
                group: "prime",
                path: info.path,
                description: info.description,
                size: "md",
                importance: 80,
            });
            nodeIds.add(agentId);
        }
    }

    // Classify all plugin notes
    for (const node of nodes) {
        const classification = classifyNote(node.id, node.path, skillDirectories);
        if (!classification) continue;

        const { kind, group, skillName } = classification;
        if (kind === "reference" && !includeReferences && node.id.startsWith("plugin/")) continue;

        const nodeId =
            kind === "core"
                ? "hive"
                : kind === "domain"
                  ? `domain:${group}`
                  : `${kind}:${skillName}`.replace(/[^a-z0-9-:]/gi, "-").toLowerCase();
        if (nodeIds.has(nodeId)) continue;
        nodeIds.add(nodeId);

        const { description, triggers } = await readNoteMetadata(node.path);

        const canvasNode: CanvasNode = {
            id: nodeId,
            label: titleCase(skillName),
            short: shortName(skillName),
            kind,
            group,
            path: node.path,
            description,
            size: kind === "domain" ? "md" : "sm",
            importance: kind === "domain" ? 60 : kind === "skill" ? 40 : 20,
        };
        if (triggers.length > 0) {
            canvasNode.triggers = triggers;
        }
        canvasNodes.push(canvasNode);
    }

    // Concept nodes: unresolved edge targets
    const agentFileStubs = new Set(Object.keys(AGENT_FILE_MAP));
    for (const edge of edges) {
        const target = edge.to;
        const matchesNode = nodes.some((n) => n.id === target || n.id.startsWith(target));
        // Skip targets that resolve to agent files
        const isAgentRef = [...agentFileStubs].some((stub) => target.includes(stub));
        if (!matchesNode && !isAgentRef && target && !target.startsWith(".") && !target.startsWith("http")) {
            const conceptId = `concept:${target.split("/").pop() ?? target}`;
            if (!nodeIds.has(conceptId)) {
                nodeIds.add(conceptId);
                canvasNodes.push({
                    id: conceptId,
                    label: titleCase(target.split("/").pop() ?? target),
                    short: "?",
                    kind: "concept",
                    group: "concept",
                    path: "",
                    description: "Relationship target without a matching routable skill",
                    size: "sm",
                    importance: 10,
                });
                warnings++;
            }
        }
    }

    // 3. Build groups
    const groupLabels: Record<string, string> = {
        core: "Collective memory",
        prime: "P.R.I.M.E. lifecycle",
        knowledge: "Knowledge",
        solutions: "Solutions",
        projects: "Projects",
        concept: "Concepts & aliases",
    };
    const usedGroups = [...new Set(canvasNodes.map((node) => node.group))];
    if (!usedGroups.includes("concept")) usedGroups.push("concept");
    const groups: { id: string; label: string; color: string }[] = usedGroups.sort().map((group) => {
        // Determine color from the dominant kind in this group
        const groupNodes = canvasNodes.filter((n) => n.group === group);
        const dominantKind = groupNodes.length > 0 ? groupNodes[0].kind : "reference";
        return {
            id: group,
            label: groupLabels[group] ?? titleCase(group.replace(/^notes-/, "").replace(/^memories-/, "")),
            color: colorForKind(dominantKind),
        };
    });

    // 3b. Folder hub detection — group reference nodes by parent folder
    const folderChildren = new Map<string, CanvasNode[]>();
    for (const node of canvasNodes) {
        if (node.kind !== "reference" || !node.path) continue;
        const parentDir = dirname(node.path).replace(/\\/g, "/");
        const parts = parentDir.split("/");
        if (parts.length <= 1) continue; // root-level notes connect directly to domain
        const folderKey = `${node.group}:${parentDir}`;
        if (!folderChildren.has(folderKey)) folderChildren.set(folderKey, []);
        folderChildren.get(folderKey)!.push(node);
    }

    // Create folder hub nodes for folders with 2+ children
    const folderHubIds = new Set<string>();
    const nodeToFolderHub = new Map<string, string>();
    for (const [folderKey, children] of folderChildren) {
        if (children.length < 2) continue;
        const [group, ...dirParts] = folderKey.split(":");
        const folderDir = dirParts.join(":");
        const folderName = folderDir.split("/").pop() ?? folderDir;
        const folderId = `folder:${folderDir.replace(/\//g, "-")}`;
        if (nodeIds.has(folderId)) continue;
        nodeIds.add(folderId);
        folderHubIds.add(folderId);
        canvasNodes.push({
            id: folderId,
            label: titleCase(folderName),
            short: shortName(folderName),
            kind: "folder",
            group,
            path: folderDir,
            description: `Folder hub — ${children.length} notes`,
            size: "md",
            importance: 45,
        });
        for (const child of children) {
            nodeToFolderHub.set(child.id, folderId);
        }
    }

    // 4. Build links
    const canvasLinks: CanvasLink[] = [];

    if (usesPlugin) {
        // Hub → agents
        for (const agentKey of Object.keys(AGENT_MAP)) {
            canvasLinks.push({ source: "hive", target: `agent:${agentKey.replace("prime-", "")}`, type: "knowledge" });
        }

        // Agent lifecycle chain
        const agentOrder = ["problem", "requirement", "instruct", "make", "evaluate"];
        for (let i = 0; i < agentOrder.length - 1; i++) {
            canvasLinks.push({
                source: `agent:${agentOrder[i]}`,
                target: `agent:${agentOrder[i + 1]}`,
                type: "lifecycle",
            });
        }
        canvasLinks.push({ source: "agent:evaluate", target: "agent:problem", type: "feedback" });
    }

    // Hub → domains
    for (const group of usedGroups) {
        if (group === "core" || group === "concept") continue;
        const domainId = `domain:${group}`;
        if (!nodeIds.has(domainId)) {
            const label = groupLabels[group] ?? titleCase(group.replace(/^notes-/, "").replace(/^memories-/, ""));
            canvasNodes.push({
                id: domainId,
                label,
                short: shortName(label),
                kind: "domain",
                group,
                path: "",
                description: `Hub for ${label}`,
                size: "md",
                importance: 60,
            });
            nodeIds.add(domainId);
        }
        canvasLinks.push({ source: "hive", target: domainId, type: "knowledge" });
    }

    // Hub → top-level folders
    for (const node of canvasNodes) {
        if (node.kind === "folder" && node.path && !node.path.includes("/")) {
            canvasLinks.push({ source: "hive", target: node.id, type: "structure" });
        }
    }

    // Reference → folder hub (if exists) or domain
    for (const node of canvasNodes) {
        if (node.kind === "core" || node.kind === "domain" || node.kind === "concept" || node.kind === "folder") continue;
        const folderHubId = nodeToFolderHub.get(node.id);
        if (folderHubId && nodeIds.has(folderHubId)) {
            canvasLinks.push({ source: folderHubId, target: node.id, type: "member" });
        } else {
            // Check if there's a top-level folder matching the note's path
            const notePath = node.path;
            if (notePath) {
                const topLevelDir = notePath.split("/")[0];
                const topLevelFolderId = `folder:${topLevelDir}`;
                if (nodeIds.has(topLevelFolderId)) {
                    canvasLinks.push({ source: topLevelFolderId, target: node.id, type: "member" });
                    continue;
                }
            }
            // Fall back to domain
            const domainId = `domain:${node.group}`;
            if (nodeIds.has(domainId)) canvasLinks.push({ source: domainId, target: node.id, type: "member" });
        }
    }

    // Folder hub → domain
    for (const folderId of folderHubIds) {
        const folderNode = canvasNodes.find((n) => n.id === folderId);
        if (!folderNode) continue;
        const domainId = `domain:${folderNode.group}`;
        if (nodeIds.has(domainId)) {
            canvasLinks.push({ source: domainId, target: folderId, type: "member" });
        }
    }

    // Edge-based links
    for (const edge of edges) {
        const sourceClass = classifyEdgeNode(edge.from, nodes, skillDirectories);
        const targetClass = classifyEdgeNode(edge.to, nodes, skillDirectories);
        if (!sourceClass || !targetClass) continue;

        if (sourceClass.kind === "domain" && targetClass.kind === "skill" && sourceClass.group === targetClass.group) {
            canvasLinks.push({
                source: `domain:${sourceClass.group}`,
                target: `skill:${targetClass.skillName}`,
                type: "skill",
            });
        } else if (
            sourceClass.kind === "domain" &&
            targetClass.kind === "reference" &&
            sourceClass.group === targetClass.group &&
            includeReferences
        ) {
            canvasLinks.push({
                source: `domain:${sourceClass.group}`,
                target: `reference:${targetClass.skillName}`,
                type: "skill",
            });
        } else if (
            sourceClass.kind === "skill" &&
            targetClass.kind === "skill" &&
            sourceClass.group !== targetClass.group
        ) {
            canvasLinks.push({
                source: `skill:${sourceClass.skillName}`,
                target: `skill:${targetClass.skillName}`,
                type: "bridge",
            });
        } else if (
            sourceClass.kind === "skill" &&
            targetClass.kind === "reference" &&
            sourceClass.group === targetClass.group &&
            includeReferences
        ) {
            canvasLinks.push({
                source: `skill:${sourceClass.skillName}`,
                target: `reference:${targetClass.skillName}`,
                type: "skill",
            });
        } else if (targetClass.kind === "concept") {
            const sourceId =
                sourceClass.kind === "domain"
                    ? `domain:${sourceClass.group}`
                    : `${sourceClass.kind}:${sourceClass.skillName}`;
            canvasLinks.push({ source: sourceId, target: `concept:${targetClass.skillName}`, type: "bridge" });
        } else if (targetClass.kind === "agent") {
            // Link to agent node (e.g., from HIVE-MIND or other notes referencing agent files)
            const sourceId =
                sourceClass.kind === "domain"
                    ? `domain:${sourceClass.group}`
                    : `${sourceClass.kind}:${sourceClass.skillName}`;
            const agentId = `agent:${targetClass.skillName.replace("prime-", "")}`;
            if (nodeIds.has(agentId)) {
                canvasLinks.push({ source: sourceId, target: agentId, type: "bridge" });
            }
        } else {
            // Generic bridge: any other cross-kind edge
            const sourceId =
                sourceClass.kind === "domain"
                    ? `domain:${sourceClass.group}`
                    : `${sourceClass.kind}:${sourceClass.skillName}`;
            const targetId =
                targetClass.kind === "domain"
                    ? `domain:${targetClass.group}`
                    : `${targetClass.kind}:${targetClass.skillName}`;
            if (sourceId !== targetId && nodeIds.has(targetId)) {
                canvasLinks.push({ source: sourceId, target: targetId, type: "bridge" });
            }
        }
    }

    // Deduplicate
    const linkSet = new Set<string>();
    const uniqueLinks = canvasLinks.filter((link) => {
        const key = `${link.source}|${link.target}|${link.type}`;
        if (linkSet.has(key)) return false;
        linkSet.add(key);
        return true;
    });

    // 5. Assemble
    const canvasData: CanvasData = {
        title: "Vault Knowledge Graph",
        subtitle: "An interactive map of the vault knowledge graph",
        schemaVersion: 4,
        groups,
        nodes: canvasNodes,
        links: uniqueLinks,
        stats: { nodes: canvasNodes.length, edges: uniqueLinks.length, warnings },
    };

    // 6. Write output (validated via centralized safety helper)
    const resolvedOutputPath = await safeWriteTarget(outputPath);
    await mkdir(dirname(resolvedOutputPath), { recursive: true });
    await writeFile(resolvedOutputPath, JSON.stringify(canvasData, null, 2), "utf-8");

    // Also write TSX if template is available
    // Privacy note: The generated TSX embeds the configured vault path to enable
    // "Open in IDE" (vscode://file/) links. This is required for the feature to work.
    // The TSX is only generated inside the vault, never transmitted externally.
    try {
        const tsxPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "templates", "hive-canvas-footer.tsx");
        const template = await readFile(tsxPath, "utf-8");
        const vaultRoot = getVaultRoot().replace(/\\/g, "/");
        // Replace any hardcoded VAULT_ROOT placeholder with the configured vault path
        // Strip @ts-nocheck directives from template (only needed for standalone IDE editing)
        const cleanedTemplate = template.replace(/\/\/ @ts-nocheck[^\n]*\n?/g, "");
        const tsxContent = `"use client";\n\nimport { useMemo, useRef, useState } from "react";\nimport type { MouseEvent as ReactMouseEvent, WheelEvent } from "react";\nimport { ReportShell } from "qoder/canvas";\nconst hiveData = ${JSON.stringify(canvasData, null, 4)};\n${cleanedTemplate.replace(/__VAULT_ROOT__/, vaultRoot)}`;
        // Derive TSX output path and validate it independently
        const tsxOutputPath = resolvedOutputPath.replace(/\.json$/, ".tsx");
        // Ensure TSX path is different from JSON path (no collision)
        if (tsxOutputPath === resolvedOutputPath) {
            // Output path doesn't end with .json — skip TSX to avoid collision
            return { nodes: canvasNodes.length, links: uniqueLinks.length, warnings, groups: groups.length };
        }
        // Validate the derived TSX path independently via safeWriteTarget
        const vaultRootForRel = getVaultRoot();
        const { relative: relPath } = await import("node:path");
        const tsxRelPath = relPath(vaultRootForRel, tsxOutputPath).replace(/\\/g, "/");
        const validatedTsxPath = await safeWriteTarget(tsxRelPath);
        await writeFile(validatedTsxPath, tsxContent, "utf-8");
    } catch {
        // Template not found or TSX generation failed — skip silently
    }

    return { nodes: canvasNodes.length, links: uniqueLinks.length, warnings, groups: groups.length };
}

/* ── MCP handler ───────────────────────────────────────────────── */

export async function handler({
    output_path,
    scan_path,
    include_references,
}: {
    output_path: string;
    scan_path: string;
    include_references: boolean;
}) {
    try {
        const result = await generateCanvas(output_path, scan_path, include_references);
        return {
            content: [
                {
                    type: "text" as const,
                    text: `Hive canvas generated at "${output_path}": ${result.nodes} nodes, ${result.links} links, ${result.warnings} warnings. Groups: ${result.groups}.`,
                },
            ],
        };
    } catch (err) {
        return {
            content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
            isError: true,
        };
    }
}
