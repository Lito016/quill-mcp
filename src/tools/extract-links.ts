import { readFile, readdir, lstat } from "node:fs/promises";
import { extname, join } from "node:path";
import { getVaultRoot, safeReadTarget } from "../utils/vault.js";
import { extractLinks } from "../utils/links.js";
import * as z from "zod";

export const name = "extract_links";
export const description =
    "Extract all links from a note or directory. Finds wiki-style links ([[note]]), heading/block references ([[note#heading]]), embeds (![[note]]), and markdown links ([text](path.md)). " +
    "Supports bulk mode for directories, link health checks, and JSON output. Auto-appends .md if no file extension is provided.";
export const inputSchema = z.object({
    path: z
        .string()
        .describe("Path to a note file or directory, relative to the vault root (.md appended if no extension)"),
    bulk: z
        .boolean()
        .default(false)
        .describe("If true and path is a directory, extract links from all notes recursively"),
    check_health: z.boolean().default(false).describe("If true, verify each link target exists and flag broken links"),
    json: z.boolean().default(false).describe("If true, output as structured JSON"),
});

export async function handler({
    path,
    bulk,
    check_health,
    json,
}: {
    path: string;
    bulk: boolean;
    check_health: boolean;
    json: boolean;
}) {
    const resolvedPath = extname(path) ? path : `${path}.md`;
    let fullPath: string;
    try {
        fullPath = await safeReadTarget(resolvedPath);
    } catch {
        return { content: [{ type: "text" as const, text: `Error: Path not found at "${path}".` }], isError: true };
    }

    // Bulk mode: scan directory
    if (bulk) {
        const dirPath = fullPath;
        const results: Array<{ file: string; links: ReturnType<typeof extractLinks> }> = [];

        async function scanDir(dir: string) {
            const entries = await readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.name === ".trash" || entry.name === ".quill-sessions" || entry.name === ".versions") continue;
                const entryPath = join(dir, entry.name);
                // Symlink defense: never recurse into symbolic links
                const entryStat = await lstat(entryPath);
                if (entryStat.isSymbolicLink()) continue;
                if (entry.isDirectory()) {
                    await scanDir(entryPath);
                } else if (entry.name.endsWith(".md")) {
                    try {
                        const content = await readFile(entryPath, "utf-8");
                        const links = extractLinks(content);
                        const relPath = entryPath.startsWith(getVaultRoot())
                            ? entryPath.slice(getVaultRoot().length + 1)
                            : entryPath;
                        results.push({ file: relPath.replace(/\\/g, "/"), links });
                    } catch {
                        // Skip unreadable files
                    }
                }
            }
        }

        await scanDir(dirPath);

        if (json) {
            const output = results.map((r) => ({
                file: r.file,
                wiki: r.links.wiki.map((l) => ({ target: l.target, heading: l.heading, isEmbed: l.isEmbed })),
                markdown: r.links.markdown.map((l) => ({ text: l.text, target: l.target, isEmbed: l.isEmbed })),
            }));
            return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
        }

        const totalLinks = results.reduce((sum, r) => sum + r.links.wiki.length + r.links.markdown.length, 0);
        const lines: string[] = [`Extracted links from ${results.length} note(s) (${totalLinks} total links):`];
        for (const r of results) {
            const count = r.links.wiki.length + r.links.markdown.length;
            if (count > 0) {
                lines.push(`\n  ${r.file} (${count} links):`);
                for (const l of r.links.wiki) {
                    lines.push(`    [[${l.target}${l.heading ? `#${l.heading}` : ""}]]`);
                }
            }
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }

    // Single file mode
    const content = await readFile(fullPath, "utf-8");
    const links = extractLinks(content);
    const wikiCount = links.wiki.length;
    const mdCount = links.markdown.length;
    const total = wikiCount + mdCount;

    // JSON output
    if (json) {
        const output = {
            file: path,
            wiki: links.wiki.map((l) => ({
                target: l.target,
                heading: l.heading,
                blockId: l.blockId,
                isEmbed: l.isEmbed,
                displayText: l.displayText,
            })),
            markdown: links.markdown.map((l) => ({ text: l.text, target: l.target, isEmbed: l.isEmbed })),
            total,
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
    }

    if (total === 0) {
        return { content: [{ type: "text" as const, text: `No links found in "${path}".` }] };
    }

    // Health check: verify link targets exist
    let brokenLinks: string[] = [];
    if (check_health) {
        const allTargets = new Set<string>();

        for (const l of links.wiki) {
            allTargets.add(l.target);
        }
        for (const l of links.markdown) {
            if (!l.target.startsWith("http") && !l.target.startsWith("#")) {
                allTargets.add(l.target);
            }
        }

        for (const target of allTargets) {
            // Use safeReadTarget for canonical realpath containment.
            // This rejects symlinks/junctions that resolve outside the vault,
            // preventing external file existence probes via link health checks.
            const relTarget = target.endsWith(".md") ? target : `${target}.md`;
            try {
                await safeReadTarget(relTarget);
            } catch {
                // Target missing or escapes vault containment — classified as broken
                brokenLinks.push(target);
            }
        }
    }

    // Categorize wiki links
    const regular = links.wiki.filter((l) => !l.isEmbed && !l.heading && !l.blockId);
    const withDisplay = links.wiki.filter((l) => !l.isEmbed && l.displayText);
    const headingLinks = links.wiki.filter((l) => !l.isEmbed && l.heading);
    const blockLinks = links.wiki.filter((l) => !l.isEmbed && l.blockId);
    const embeds = links.wiki.filter((l) => l.isEmbed);

    const parts: string[] = [`Found ${total} link(s) in "${path}":`];

    if (regular.length > 0) {
        parts.push(`\nWiki links (${regular.length}):`);
        for (const l of regular) {
            const broken = brokenLinks.includes(l.target) ? " ⚠️ BROKEN" : "";
            parts.push(`  [[${l.target}]]${broken}`);
        }
    }

    if (withDisplay.length > 0) {
        parts.push(`\nWiki links with display text (${withDisplay.length}):`);
        for (const l of withDisplay) {
            const broken = brokenLinks.includes(l.target) ? " ⚠️ BROKEN" : "";
            parts.push(`  [[${l.target}|${l.displayText}]]${broken}`);
        }
    }

    if (headingLinks.length > 0) {
        parts.push(`\nHeading references (${headingLinks.length}):`);
        for (const l of headingLinks) {
            parts.push(`  [[${l.target}#${l.heading}]]`);
        }
    }

    if (blockLinks.length > 0) {
        parts.push(`\nBlock references (${blockLinks.length}):`);
        for (const l of blockLinks) {
            parts.push(`  [[${l.target}#^${l.blockId}]]`);
        }
    }

    if (embeds.length > 0) {
        parts.push(`\nEmbeds (${embeds.length}):`);
        for (const l of embeds) {
            parts.push(`  ![[${l.target}]]`);
        }
    }

    if (links.markdown.length > 0) {
        const mdRegular = links.markdown.filter((l) => !l.isEmbed);
        const mdEmbeds = links.markdown.filter((l) => l.isEmbed);

        if (mdRegular.length > 0) {
            parts.push(`\nMarkdown links (${mdRegular.length}):`);
            for (const l of mdRegular) {
                parts.push(`  [${l.text}](${l.target})`);
            }
        }

        if (mdEmbeds.length > 0) {
            parts.push(`\nMarkdown embeds (${mdEmbeds.length}):`);
            for (const l of mdEmbeds) {
                parts.push(`  ![${l.text}](${l.target})`);
            }
        }
    }

    if (brokenLinks.length > 0) {
        parts.push(`\n⚠️ Broken links (${brokenLinks.length}): ${brokenLinks.join(", ")}`);
    }

    return { content: [{ type: "text" as const, text: parts.join("\n") }] };
}
