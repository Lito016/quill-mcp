/**
 * In-memory search index with BM25 ranking.
 *
 * Pre-tokenises vault content for instant lookups instead of
 * reading every file from disk on every search call.
 * Supports incremental invalidation via a dirty flag.
 */

import { readdir, readFile, stat, lstat } from "node:fs/promises";
import { relative } from "node:path";
import { getVaultRoot } from "./vault.js";
import { parseFrontmatter } from "./frontmatter.js";
import { levenshteinDistance, autoTolerance } from "./fuzzy-search.js";

// ─── Types ───────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([".trash", ".versions", ".quill-sessions", ".git", "node_modules"]);
const TOKEN_RE = /[\p{L}\p{N}]+/gu;

export interface IndexedDocument {
    /** Vault-relative path with forward slashes */
    path: string;
    /** File name including extension */
    filename: string;
    /** File size in bytes */
    size: number;
    /** ISO modified timestamp */
    modified: string;
    /** Raw content (full file) */
    rawContent: string;
    /** Content split into lines (trimmed) */
    lines: string[];
    /** Parsed frontmatter record */
    frontmatter: Record<string, unknown>;
    /** Normalised tags from frontmatter */
    tags: string[];
    /** Normalised title from frontmatter */
    title?: string;
    /** Number of whitespace-delimited tokens in the body */
    tokenCount: number;
    /** Token → term-frequency map for BM25 */
    termFreq: Map<string, number>;
}

export interface BM25Params {
    k1: number;
    b: number;
}

const DEFAULT_BM25: BM25Params = { k1: 1.2, b: 0.75 };

// ─── Search Index ────────────────────────────────────────────────────

class SearchIndex {
    private documents = new Map<string, IndexedDocument>();
    /** Inverted index: token → set of doc paths */
    private inverted = new Map<string, Set<string>>();
    /** Fingerprint cache for incremental sync (path → mtime:size) */
    private fingerprints = new Map<string, string>();
    /** lowercase path → actual indexed key (Windows case-insensitivity) */
    private caseIndex = new Map<string, string>();
    /** Paths queued for precise re-check on the next sync (see index-invalidation.ts) */
    private pendingInvalidations = new Set<string>();
    private dirty = true;
    private totalDocs = 0;
    private avgDocLength = 0;
    /** All unique indexed terms (for "did you mean") */
    private allTerms: string[] = [];

    // ── Public API ───────────────────────────────────────────────────

    markDirty(): void {
        this.dirty = true;
    }

    async ensureSynchronized(): Promise<void> {
        if (this.dirty || this.documents.size === 0) {
            this.pendingInvalidations.clear();
            await this.build();
            return;
        }
        if (this.pendingInvalidations.size === 0) return;
        const pending = [...this.pendingInvalidations];
        this.pendingInvalidations.clear();
        for (const path of pending) await this.reconcilePath(path);
        this.recomputeStats();
    }

    /**
     * Queue a precise re-check of one vault-relative path on the next sync.
     * Unlike markDirty, this never triggers a full vault walk on its own.
     */
    invalidatePath(path: string): void {
        this.pendingInvalidations.add(path.replace(/\\/g, "/"));
    }

    getDocuments(): IndexedDocument[] {
        return [...this.documents.values()];
    }

    getDocument(path: string): IndexedDocument | undefined {
        return this.documents.get(path);
    }

    /**
     * Return all unique indexed terms (useful for "did you mean" suggestions).
     */
    getAllTerms(): string[] {
        return this.allTerms;
    }

    /**
     * Compute BM25 score for a set of query tokens against a document.
     */
    bm25Score(doc: IndexedDocument, queryTokens: string[], params: BM25Params = DEFAULT_BM25): number {
        let score = 0;
        const docLen = doc.tokenCount || 1;
        for (const token of queryTokens) {
            const tf = doc.termFreq.get(token) ?? 0;
            if (tf === 0) continue;
            const df = this.inverted.get(token)?.size ?? 0;
            const idf = Math.log(1 + (this.totalDocs - df + 0.5) / (df + 0.5));
            const tfNorm =
                (tf * (params.k1 + 1)) / (tf + params.k1 * (1 - params.b + params.b * (docLen / this.avgDocLength)));
            score += idf * tfNorm;
        }
        return score;
    }

    /**
     * Find the closest indexed term to `word` using Levenshtein distance.
     * Returns undefined if no close match exists.
     */
    suggestCorrection(word: string): string | undefined {
        const normalized = word.toLowerCase();
        const tol = Math.max(1, autoTolerance(normalized.length));
        let best: string | undefined;
        let bestDist = tol + 1;

        for (const term of this.allTerms) {
            if (Math.abs(term.length - normalized.length) > tol) continue;
            const dist = levenshteinDistance(normalized, term);
            if (dist < bestDist) {
                bestDist = dist;
                best = term;
            }
        }
        return best && bestDist <= tol ? best : undefined;
    }

    /**
     * Return the inverted index for external candidate filtering.
     * Maps each indexed token to the set of document paths containing it.
     */
    getInvertedIndex(): Map<string, Set<string>> {
        return this.inverted;
    }

    // ── Index Building ───────────────────────────────────────────────

    private async build(): Promise<void> {
        await this.synchronize();
    }

    /**
     * Incremental sync: only re-reads files whose fingerprint (mtime:size) changed.
     * Removes entries for deleted files and indexes new or modified files.
     */
    private async synchronize(): Promise<void> {
        const root = getVaultRoot();
        const seen = new Set<string>();
        this.pendingInvalidations.clear();

        await this.scanDir(root, root, seen);

        // Remove entries for deleted files
        for (const path of [...this.documents.keys()]) {
            if (!seen.has(path)) this.removeDoc(path);
        }
        for (const path of [...this.fingerprints.keys()]) {
            if (!seen.has(path)) this.fingerprints.delete(path);
        }

        this.recomputeStats();
        this.dirty = false;
    }

    /** Recompute BM25 globals (doc count, average length) and the term list. */
    private recomputeStats(): void {
        this.totalDocs = this.documents.size;
        let totalTokens = 0;
        for (const doc of this.documents.values()) totalTokens += doc.tokenCount;
        this.avgDocLength = this.totalDocs > 0 ? totalTokens / this.totalDocs : 1;
        // Collect unique terms for suggestions
        this.allTerms = [...this.inverted.keys()].sort();
    }

    /** Remove a document from the index and clean up its inverted entries. */
    private removeDoc(path: string): void {
        const doc = this.documents.get(path);
        if (doc) {
            // Walk only this document's own tokens instead of every posting list
            for (const token of doc.termFreq.keys()) {
                const set = this.inverted.get(token);
                if (set) {
                    set.delete(path);
                    if (set.size === 0) this.inverted.delete(token);
                }
            }
            this.documents.delete(path);
        }
        this.fingerprints.delete(path);
        this.caseIndex.delete(path.toLowerCase());
    }

    /**
     * Re-check exactly one path after a server-side mutation: re-index it when
     * it changed, remove it when it vanished, or reconcile its subtree when it
     * is a folder (create/rename/delete of directories).
     */
    private async reconcilePath(pendingPath: string): Promise<void> {
        if (pendingPath.split("/").some((segment) => segment === "" || segment === "..")) return;
        const root = getVaultRoot();
        const fullPath = `${root}/${pendingPath}`;
        const key = this.documents.has(pendingPath) ? pendingPath : this.caseIndex.get(pendingPath.toLowerCase());
        let info;
        try {
            info = await lstat(fullPath);
        } catch {
            if (key) this.removeDoc(key);
            return;
        }
        if (info.isSymbolicLink()) {
            if (key) this.removeDoc(key);
            return;
        }
        if (info.isDirectory()) {
            await this.reconcileDirectory(root, pendingPath);
            return;
        }
        if (!info.isFile()) return;
        try {
            const s = await stat(fullPath);
            const fingerprint = `${s.mtimeMs}:${s.size}`;
            if (key && this.fingerprints.get(key) === fingerprint) return;
            await this.indexFile(root, fullPath, fingerprint, key ?? pendingPath);
        } catch {
            if (key) this.removeDoc(key);
        }
    }

    /** Re-index a folder subtree and prune indexed docs that vanished with it. */
    private async reconcileDirectory(root: string, dirRel: string): Promise<void> {
        const seen = new Set<string>();
        await this.scanDir(root, `${root}/${dirRel}`, seen);
        const prefix = `${dirRel.toLowerCase()}/`;
        for (const path of [...this.documents.keys()]) {
            if (path.toLowerCase().startsWith(prefix) && !seen.has(path)) this.removeDoc(path);
        }
    }

    /** Per-directory I/O width for scans (bounded, not sequential, not unbounded). */
    private static readonly SCAN_WIDTH = 16;

    private async scanDir(root: string, dir: string, seen: Set<string>): Promise<void> {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        const subdirs: string[] = [];
        const files: { fullPath: string; relPath: string }[] = [];
        for (const entry of entries) {
            if (SKIP_DIRS.has(entry.name)) continue;
            const fullPath = `${dir}/${entry.name}`;
            if (entry.isDirectory()) {
                subdirs.push(fullPath);
            } else if (entry.isFile() && entry.name.endsWith(".md")) {
                files.push({ fullPath, relPath: relative(root, fullPath).replace(/\\/g, "/") });
            }
        }
        // Stat/read markdown files with bounded concurrency
        for (let i = 0; i < files.length; i += SearchIndex.SCAN_WIDTH) {
            await Promise.all(
                files.slice(i, i + SearchIndex.SCAN_WIDTH).map(async ({ fullPath, relPath }) => {
                    try {
                        // Symlink defense: never index symbolic links
                        if ((await lstat(fullPath)).isSymbolicLink()) return;
                        seen.add(relPath);
                        const s = await stat(fullPath);
                        const fingerprint = `${s.mtimeMs}:${s.size}`;
                        if (this.fingerprints.get(relPath) === fingerprint) return;
                        await this.indexFile(root, fullPath, fingerprint, relPath);
                    } catch {
                        // Skip unreadable
                    }
                }),
            );
        }
        // Recurse into subdirectories (each serialises its own subtree scan)
        await Promise.all(
            subdirs.map(async (subdir) => {
                try {
                    // Symlink defense: never recurse into symbolic links
                    if ((await lstat(subdir)).isSymbolicLink()) return;
                    await this.scanDir(root, subdir, seen);
                } catch {
                    // Skip inaccessible directories
                }
            }),
        );
    }

    private async indexFile(root: string, fullPath: string, fingerprint: string, relPath: string): Promise<void> {
        const raw = await readFile(fullPath, "utf-8");
        const { frontmatter } = parseFrontmatter(raw);

        const lines = raw.split("\n").map((l) => l.trim());
        const tokens = raw.toLowerCase().match(TOKEN_RE) ?? [];
        const tokenCount = tokens.length;

        // Build term-frequency map
        const termFreq = new Map<string, number>();
        for (const t of tokens) {
            termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
        }

        // Normalise tags
        const rawTags = frontmatter.tags;
        const tags = normaliseList(rawTags);
        const title = typeof frontmatter.title === "string" ? frontmatter.title : undefined;

        let fileSize = 0;
        let modified = "";
        try {
            const s = await stat(fullPath);
            fileSize = s.size;
            modified = s.mtime.toISOString();
        } catch {
            // Ignore
        }

        // Remove old inverted entries if updating an existing doc
        const existing = this.documents.get(relPath);
        if (existing) {
            for (const token of existing.termFreq.keys()) {
                const set = this.inverted.get(token);
                if (set) {
                    set.delete(relPath);
                    if (set.size === 0) this.inverted.delete(token);
                }
            }
        }

        const doc: IndexedDocument = {
            path: relPath,
            filename: relPath.split("/").pop() ?? relPath,
            size: fileSize,
            modified,
            rawContent: raw,
            lines,
            frontmatter,
            tags,
            title,
            tokenCount,
            termFreq,
        };

        this.documents.set(relPath, doc);
        this.fingerprints.set(relPath, fingerprint);
        this.caseIndex.set(relPath.toLowerCase(), relPath);

        // Update inverted index with new tokens
        for (const token of termFreq.keys()) {
            let set = this.inverted.get(token);
            if (!set) {
                set = new Set();
                this.inverted.set(token, set);
            }
            set.add(relPath);
        }
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────

function normaliseList(raw: unknown): string[] {
    if (!raw) return [];
    const items = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
    return items
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim().replace(/^#/, "").toLowerCase())
        .filter(Boolean);
}

// ─── Singleton ────────────────────────────────────────────────────────

export const searchIndex = new SearchIndex();
