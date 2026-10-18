import { resolveVaultPath, pathExists } from "../utils/vault.js";
import { estimateTokens, formatTokenEstimate } from "../utils/tokens.js";
import { searchIndex, type IndexedDocument } from "../utils/search-index.js";
import { fuzzyMatch, parseSearchOperators, highlightMatches, type ParsedQuery } from "../utils/fuzzy-search.js";
import { MAX_PAGINATION_LIMIT, MAX_QUERY_LENGTH } from "../utils/errors.js";
import * as z from "zod";

export const name = "search_notes";
export const description = [
    "Search note contents with BM25 ranking, fuzzy matching, and advanced operators.",
    'Operators: "exact phrase", tag:value, path:value, -exclude.',
    "Options: fuzzy (typo-tolerant), highlight (bold matches), sort (relevance|date|size|name),",
    "snippets (context lines), frontmatter_only (metadata scan), deduplicate (group by file),",
    'wildcard (glob content patterns). Returns "did you mean" suggestions on zero results.',
].join(" ");

export const inputSchema = z.object({
    query: z
        .string()
        .max(MAX_QUERY_LENGTH)
        .describe(
            'Text to search for. Supports operators: "exact phrase", tag:value, path:value, -exclude. ' +
                "Multi-word queries match all words (AND logic). Use useRegex=true for raw pattern matching.",
        ),
    path: z.string().default(".").describe("Directory to search in, relative to the vault root (default: root)"),
    fileExtension: z.string().default("").describe("File extension filter (default: empty = search all files)."),
    useRegex: z
        .boolean()
        .default(false)
        .describe("If true, treat query as a regex pattern. Operators and fuzzy are ignored."),
    fuzzy: z.boolean().default(false).describe("Enable typo-tolerant fuzzy matching (Levenshtein distance)."),
    highlight: z.boolean().default(false).describe("Wrap matched text in **bold** markers in results."),
    sort: z
        .enum(["relevance", "date", "size", "name"])
        .default("relevance")
        .describe("Sort order for results. 'relevance' uses BM25 scoring when possible."),
    snippets: z
        .number()
        .min(0)
        .max(5)
        .default(0)
        .describe("Number of context lines to show before/after each match (0 = match line only)."),
    frontmatter_only: z
        .boolean()
        .default(false)
        .describe("If true, search only frontmatter metadata (title, tags, aliases) — fast metadata scan."),
    deduplicate: z.boolean().default(false).describe("If true, group results by file and show max 3 matches per file."),
    wildcard: z
        .boolean()
        .default(false)
        .describe("If true, treat query terms as glob patterns (* = any chars, ? = single char) for content matching."),
    limit: z.number().max(MAX_PAGINATION_LIMIT).optional().describe(`Maximum number of results to return (max ${MAX_PAGINATION_LIMIT})`),
    offset: z.number().default(0).describe("Number of results to skip (for pagination)"),
    showTokenEstimate: z.boolean().default(false).describe("Append estimated token count to results (default: false)"),
});

// ─── Result Types ─────────────────────────────────────────────────────

interface SearchResult {
    path: string;
    lineNum: number;
    line: string;
    snippet?: string;
    bm25: number;
    modified: string;
    size: number;
}

// ─── Handler ──────────────────────────────────────────────────────────

export async function handler({
    query,
    path,
    fileExtension,
    useRegex,
    fuzzy,
    highlight,
    sort,
    snippets,
    frontmatter_only,
    deduplicate,
    wildcard,
    limit,
    offset,
    showTokenEstimate,
}: {
    query: string;
    path: string;
    fileExtension: string;
    useRegex: boolean;
    fuzzy: boolean;
    highlight: boolean;
    sort: "relevance" | "date" | "size" | "name";
    snippets: number;
    frontmatter_only: boolean;
    deduplicate: boolean;
    wildcard: boolean;
    limit?: number;
    offset: number;
    showTokenEstimate: boolean;
}) {
    const dirPath = resolveVaultPath(path);

    if (!(await pathExists(dirPath))) {
        return {
            content: [{ type: "text" as const, text: `Error: Directory not found at "${path}".` }],
            isError: true,
        };
    }

    // Ensure the in-memory index is ready
    await searchIndex.ensureSynchronized();

    // ── Parse operators (unless regex mode) ──────────────────────────
    const parsed: ParsedQuery | null = useRegex ? null : parseSearchOperators(query);
    const needsFrontmatter = parsed !== null && (parsed.tags.length > 0 || parsed.paths.length > 0);

    // ── Build line-level matching ────────────────────────────────────
    let singlePattern: RegExp | null = null;
    let multiPatterns: RegExp[] | null = null;
    let fuzzyTerms: string[] = [];
    let phrasePatterns: RegExp[] = [];
    let excludePatterns: RegExp[] = [];
    let highlightPatterns: string[] = [];
    let wildcardPatterns: RegExp[] = [];

    if (useRegex) {
        try {
            singlePattern = new RegExp(query, "i");
        } catch {
            return {
                content: [{ type: "text" as const, text: `Error: Invalid regex pattern: "${query}".` }],
                isError: true,
            };
        }
    } else if (wildcard) {
        // Wildcard mode: convert glob terms to regex
        const words = query.trim().split(/\s+/).filter(Boolean);
        for (const word of words) {
            wildcardPatterns.push(globWordToRegex(word));
            highlightPatterns.push(word.replace(/[*?]/g, ""));
        }
    } else if (parsed!.hasOperators) {
        for (const phrase of parsed!.phrases) {
            const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            phrasePatterns.push(new RegExp(escaped, "i"));
            highlightPatterns.push(phrase);
        }
        if (fuzzy) {
            fuzzyTerms = parsed!.terms;
            highlightPatterns.push(...parsed!.terms);
        } else {
            for (const term of parsed!.terms) {
                const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                multiPatterns = multiPatterns ?? [];
                multiPatterns.push(new RegExp(escaped, "i"));
                highlightPatterns.push(term);
            }
        }
        for (const exc of parsed!.excludes) {
            const escaped = exc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            excludePatterns.push(new RegExp(escaped, "i"));
        }
    } else {
        const words = query
            .trim()
            .split(/\s+/)
            .filter((w) => w.length > 0);
        if (fuzzy) {
            fuzzyTerms = words;
            highlightPatterns.push(...words);
        } else if (words.length <= 1) {
            const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            try {
                singlePattern = new RegExp(escaped, "i");
            } catch {
                return {
                    content: [{ type: "text" as const, text: `Error: Invalid search pattern: "${query}".` }],
                    isError: true,
                };
            }
            highlightPatterns.push(query.trim());
        } else {
            multiPatterns = words.map((word) => {
                const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                return new RegExp(escaped, "i");
            });
            highlightPatterns.push(...words);
        }
    }

    // ── Line matcher ─────────────────────────────────────────────────
    function matchesLine(line: string): boolean {
        if (
            singlePattern &&
            !multiPatterns &&
            !fuzzyTerms.length &&
            !phrasePatterns.length &&
            !wildcardPatterns.length
        ) {
            return singlePattern.test(line);
        }
        if (excludePatterns.some((p) => p.test(line))) return false;
        if (phrasePatterns.length && !phrasePatterns.every((p) => p.test(line))) return false;
        if (multiPatterns && !multiPatterns.every((p) => p.test(line))) return false;
        if (fuzzyTerms.length && !fuzzyTerms.every((term) => fuzzyMatch(term, line))) return false;
        if (wildcardPatterns.length && !wildcardPatterns.every((p) => p.test(line))) return false;
        return true;
    }

    // ── Frontmatter-only mode ────────────────────────────────────────
    if (frontmatter_only) {
        return await handleFrontmatterOnly(
            query,
            parsed,
            dirPath,
            path,
            fileExtension,
            highlight,
            sort,
            limit,
            offset,
            showTokenEstimate,
        );
    }

    // ── File-level frontmatter filter ────────────────────────────────
    function passesFrontmatter(doc: IndexedDocument): boolean {
        if (!needsFrontmatter) return true;
        if (parsed!.tags.length) {
            if (!parsed!.tags.every((t) => doc.tags.includes(t))) return false;
        }
        if (parsed!.paths.length) {
            const fp = doc.path.toLowerCase();
            if (!parsed!.paths.every((p) => fp.includes(p))) return false;
        }
        return true;
    }

    // ── Collect results using the in-memory index ────────────────────
    const queryTokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const results: SearchResult[] = [];
    const allDocs = searchIndex.getDocuments();

    // Boundary-aware path restriction: "Projects" must not match "ProjectsX/..."
    const searchPrefix = path === "." ? "" : path.replace(/\/+$/, "");
    const withinSearchPath = (docPath: string): boolean =>
        !searchPrefix || docPath === searchPrefix || docPath.startsWith(`${searchPrefix}/`);

    // Document-level BM25 is computed once per doc, not once per matching line
    const bm25Cache = new Map<string, number>();
    const bm25For = (doc: IndexedDocument): number => {
        if (queryTokens.length === 0) return 0;
        let score = bm25Cache.get(doc.path);
        if (score === undefined) {
            score = searchIndex.bm25Score(doc, queryTokens);
            bm25Cache.set(doc.path, score);
        }
        return score;
    };

    // Inverted-index candidate filtering: only scan documents that contain
    // at least one query term. Falls back to all docs for regex, wildcard,
    // fuzzy, and phrase-only queries where the inverted index cannot help.
    const useInverted = !useRegex && !wildcard && !fuzzy && !parsed?.hasOperators && queryTokens.length > 0;
    let docsToSearch: IndexedDocument[];
    if (useInverted) {
        const inverted = searchIndex.getInvertedIndex();
        const candidatePaths = new Set<string>();
        for (const token of queryTokens) {
            const posting = inverted.get(token);
            if (posting) {
                for (const p of posting) candidatePaths.add(p);
            }
        }
        docsToSearch = allDocs.filter((d) => candidatePaths.has(d.path));
    } else {
        docsToSearch = allDocs;
    }

    for (const doc of docsToSearch) {
        // Boundary-aware path restriction
        if (!withinSearchPath(doc.path)) continue;

        // Extension filter
        if (fileExtension && !doc.filename.endsWith(fileExtension)) continue;

        // Frontmatter gate
        if (!passesFrontmatter(doc)) continue;

        // Server-side mutations invalidate the index synchronously (utils/index-invalidation.ts)
        // and external edits are caught by the watcher poll, so no per-doc disk check is needed.
        // Skip anything in .trash or .versions
        if (doc.path.includes(".trash/") || doc.path.includes(".versions/")) continue;

        // Per-file match count for dedup
        let fileMatchCount = 0;
        const MAX_PER_FILE = deduplicate ? 3 : Infinity;

        for (let i = 0; i < doc.lines.length; i++) {
            const trimmed = doc.lines[i];
            if (!trimmed) continue;
            if (!matchesLine(trimmed)) continue;

            if (fileMatchCount >= MAX_PER_FILE) continue;
            fileMatchCount++;

            // BM25 score (cached per document)
            const bm25 = bm25For(doc);

            // Snippet extraction
            let snippet: string | undefined;
            if (snippets > 0) {
                snippet = extractSnippet(doc.lines, i, snippets);
            }

            results.push({
                path: doc.path,
                lineNum: i + 1,
                line: trimmed,
                snippet,
                bm25,
                modified: doc.modified,
                size: doc.size,
            });
        }
    }

    // ── Sort ─────────────────────────────────────────────────────────
    sortResults(results, sort);

    // ── "Did you mean" on zero results ───────────────────────────────
    if (results.length === 0 && !useRegex) {
        const suggestion = buildSuggestion(queryTokens);
        const mode = fuzzy ? " (fuzzy)" : "";
        const text = suggestion
            ? `No matches found for "${query}"${mode}.\n\nDid you mean: "${suggestion}"?`
            : `No matches found for "${query}"${mode}.`;
        return { content: [{ type: "text" as const, text }] };
    }

    // ── Format output ────────────────────────────────────────────────
    const total = results.length;
    const paginated = limit ? results.slice(offset, offset + limit) : results.slice(offset);
    const formatted = formatResults(paginated, highlight, highlightPatterns, snippets > 0);
    const resultText = formatted.join("\n");
    const tokenSuffix = showTokenEstimate ? `\n\n[${formatTokenEstimate(estimateTokens(resultText))} estimated]` : "";

    const isPaginated = limit !== undefined || offset > 0;
    const prefix = isPaginated ? `Showing ${paginated.length} of ${total} match(es):\n` : `Found ${total} match(es):\n`;

    const modes: string[] = [];
    if (fuzzy) modes.push("fuzzy");
    if (parsed?.hasOperators) modes.push("operators");
    if (highlight) modes.push("highlight");
    if (sort === "relevance" && !useRegex) modes.push("bm25");
    if (snippets > 0) modes.push(`snippets:${snippets}`);
    if (deduplicate) modes.push("dedup");
    if (wildcard) modes.push("wildcard");
    const modeSuffix = modes.length ? `  [${modes.join(", ")}]` : "";

    return { content: [{ type: "text" as const, text: `${prefix}${resultText}${tokenSuffix}${modeSuffix}` }] };
}

// ─── Frontmatter-Only Handler ─────────────────────────────────────────

async function handleFrontmatterOnly(
    query: string,
    parsed: ParsedQuery | null,
    dirPath: string,
    searchPath: string,
    fileExtension: string,
    highlight: boolean,
    sort: string,
    limit: number | undefined,
    offset: number,
    showTokenEstimate: boolean,
) {
    const searchTerms = parsed?.terms ?? query.trim().split(/\s+/).filter(Boolean);
    const results: SearchResult[] = [];
    const allDocs = searchIndex.getDocuments();

    // Boundary-aware path restriction: "Projects" must not match "ProjectsX/..."
    const searchPrefix = searchPath === "." ? "" : searchPath.replace(/\/+$/, "");
    const withinSearchPath = (docPath: string): boolean =>
        !searchPrefix || docPath === searchPrefix || docPath.startsWith(`${searchPrefix}/`);

    for (const doc of allDocs) {
        // Index is invalidated synchronously on server-side mutation; skip .trash and .versions
        if (doc.path.includes(".trash/") || doc.path.includes(".versions/")) continue;

        if (!withinSearchPath(doc.path)) continue;
        if (fileExtension && !doc.filename.endsWith(fileExtension)) continue;

        // Search in title, tags, and all frontmatter string values
        const fmText = buildFrontmatterText(doc);
        const matches = searchTerms.every((term) => fmText.toLowerCase().includes(term.toLowerCase()));
        if (!matches) continue;

        results.push({
            path: doc.path,
            lineNum: 0,
            line: doc.title ?? doc.filename,
            bm25: 0,
            modified: doc.modified,
            size: doc.size,
        });
    }

    sortResults(results, sort as "relevance" | "date" | "size" | "name");

    if (results.length === 0) {
        return { content: [{ type: "text" as const, text: `No frontmatter matches for "${query}".` }] };
    }

    const total = results.length;
    const paginated = limit ? results.slice(offset, offset + limit) : results.slice(offset);
    const lines = paginated.map((r) => {
        const display = highlight ? highlightMatches(r.line, searchTerms) : r.line;
        return `${r.path}: ${display}`;
    });
    const resultText = lines.join("\n");
    const tokenSuffix = showTokenEstimate ? `\n\n[${formatTokenEstimate(estimateTokens(resultText))} estimated]` : "";
    const isPaginated = limit !== undefined || offset > 0;
    const prefix = isPaginated ? `Showing ${paginated.length} of ${total} match(es):\n` : `Found ${total} match(es):\n`;

    return { content: [{ type: "text" as const, text: `${prefix}${resultText}${tokenSuffix}  [frontmatter_only]` }] };
}

// ─── Helpers ──────────────────────────────────────────────────────────

function sortResults(results: SearchResult[], sort: string): void {
    switch (sort) {
        case "relevance":
            results.sort((a, b) => b.bm25 - a.bm25 || a.path.localeCompare(b.path));
            break;
        case "date":
            results.sort((a, b) => b.modified.localeCompare(a.modified));
            break;
        case "size":
            results.sort((a, b) => b.size - a.size);
            break;
        case "name":
            results.sort((a, b) => a.path.localeCompare(b.path));
            break;
    }
}

function extractSnippet(lines: string[], matchIdx: number, radius: number): string {
    const start = Math.max(0, matchIdx - radius);
    const end = Math.min(lines.length - 1, matchIdx + radius);
    const snippetLines: string[] = [];
    for (let i = start; i <= end; i++) {
        const marker = i === matchIdx ? ">" : " ";
        const text = lines[i]?.trim() ?? "";
        if (text) snippetLines.push(`${marker} ${text}`);
    }
    return snippetLines.join("\n");
}

function formatResults(
    results: SearchResult[],
    highlight: boolean,
    patterns: string[],
    hasSnippets: boolean,
): string[] {
    return results.map((r) => {
        const line = highlight ? highlightMatches(r.line, patterns) : r.line;
        if (hasSnippets && r.snippet) {
            const snippetBlock = r.snippet
                .split("\n")
                .map((sl) => `  ${highlight ? highlightMatches(sl, patterns) : sl}`)
                .join("\n");
            return `${r.path}:${r.lineNum}:\n${snippetBlock}`;
        }
        return `${r.path}:${r.lineNum}: ${line}`;
    });
}

function buildFrontmatterText(doc: IndexedDocument): string {
    const parts: string[] = [];
    if (doc.title) parts.push(doc.title);
    parts.push(...doc.tags);
    // Include aliases
    const aliases = doc.frontmatter.aliases;
    if (Array.isArray(aliases)) {
        parts.push(...aliases.filter((v): v is string => typeof v === "string"));
    } else if (typeof aliases === "string") {
        parts.push(aliases);
    }
    // Include category and phase
    if (typeof doc.frontmatter.category === "string") parts.push(doc.frontmatter.category);
    if (typeof doc.frontmatter.phase === "string") parts.push(doc.frontmatter.phase);
    return parts.join(" ");
}

function buildSuggestion(queryTokens: string[]): string | undefined {
    if (!queryTokens.length) return undefined;
    const corrections: string[] = [];
    for (const token of queryTokens) {
        const correction = searchIndex.suggestCorrection(token);
        corrections.push(correction ?? token);
    }
    const suggestion = corrections.join(" ");
    // Only suggest if at least one token was actually corrected
    const changed = corrections.some((c, i) => c !== queryTokens[i]);
    return changed ? suggestion : undefined;
}

function globWordToRegex(word: string): RegExp {
    let source = "";
    for (const ch of word) {
        if (ch === "*") source += ".*";
        else if (ch === "?") source += ".";
        else source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(source, "i");
}
