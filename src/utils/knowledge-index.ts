import { readdir, readFile, stat, lstat } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { getVaultRoot, resolveVaultPath } from "./vault.js";
import { parseFrontmatter } from "./frontmatter.js";
import { levenshteinDistance, autoTolerance } from "./fuzzy-search.js";

export const DISCOVERY_FIELDS = ["filename", "path", "title", "tags", "aliases", "headings", "content"] as const;
export type DiscoveryField = (typeof DISCOVERY_FIELDS)[number];
export type ResourceType = "file" | "folder";

export interface KnowledgeEntry {
    path: string;
    filename: string;
    extension: string;
    folder: string;
    title?: string;
    tags: string[];
    aliases: string[];
    headings: string[];
    size: number;
    modified: string;
    preview?: string;
    contentTokens: Map<string, number>;
    fingerprint: string;
}

export interface DiscoveryResult {
    path: string;
    filename: string;
    type: ResourceType;
    title?: string;
    tags?: string[];
    aliases?: string[];
    score: number;
    matched_on: DiscoveryField[];
    preview?: string;
}

const SKIPPED_DIRECTORIES = new Set([".trash", ".versions", ".quill-sessions", ".git", "node_modules"]);

function normalized(value: string): string {
    return value.normalize("NFKC").trim().toLocaleLowerCase();
}

function stringList(value: unknown): string[] {
    const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
    const result = new Map<string, string>();
    for (const item of values) {
        if (typeof item !== "string") continue;
        const clean = item.trim().replace(/^#/, "");
        if (clean) result.set(normalized(clean), clean);
    }
    return [...result.values()];
}

function tokenize(value: string): string[] {
    return normalized(value).match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

function contentTokenMap(value: string): Map<string, number> {
    const result = new Map<string, number>();
    for (const token of tokenize(value)) result.set(token, (result.get(token) ?? 0) + 1);
    return result;
}

function preview(body: string): string | undefined {
    const text = body
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/[`*_>[\]()]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return text ? text.slice(0, 240) : undefined;
}

function relativePath(root: string, fullPath: string): string {
    return relative(root, fullPath).replace(/\\/g, "/");
}

function isWithinFolder(path: string, folder: string): boolean {
    if (!folder || folder === ".") return true;
    return path === folder || path.startsWith(`${folder}/`);
}

export function normalizeVaultRelativePath(input = "."): string {
    const fullPath = resolveVaultPath(input || ".");
    const rel = relativePath(getVaultRoot(), fullPath);
    return rel === "" ? "." : rel.replace(/\/$/, "");
}

/**
 * Check if any word-sized window in `field` fuzzy-matches `query`.
 * Compares the full query against each whitespace-delimited word in the field,
 * using auto-scaled Levenshtein tolerance.
 */
function fuzzyFieldMatch(field: string, query: string): boolean {
    if (!query || !field) return false;
    const words = field.split(/[\s/_.-]+/).filter(Boolean);
    const tol = autoTolerance(query.length);
    return words.some((word) => {
        if (Math.abs(word.length - query.length) > tol) return false;
        return levenshteinDistance(word, query) <= tol;
    });
}

class KnowledgeIndex {
    private entries = new Map<string, KnowledgeEntry>();
    private folders = new Set<string>();
    /** Inverted term index: normalised token → set of entry paths */
    private termIndex = new Map<string, Set<string>>();
    /** lowercase path → actual indexed key (Windows case-insensitivity) */
    private caseIndex = new Map<string, string>();
    /** Paths queued for precise re-check on the next sync (see index-invalidation.ts) */
    private pendingInvalidations = new Set<string>();
    private root = "";
    private initialized = false;
    private dirty = true;

    isInitialized(): boolean {
        return this.initialized && this.root === getVaultRoot();
    }

    reset(): void {
        this.entries.clear();
        this.folders.clear();
        this.termIndex.clear();
        this.caseIndex.clear();
        this.pendingInvalidations.clear();
        this.root = "";
        this.initialized = false;
        this.dirty = true;
    }

    markDirty(): void {
        this.dirty = true;
    }

    async ensureSynchronized(): Promise<void> {
        if (!this.isInitialized() || this.dirty) {
            this.pendingInvalidations.clear();
            await this.synchronize();
            return;
        }
        if (this.pendingInvalidations.size === 0) return;
        const pending = [...this.pendingInvalidations];
        this.pendingInvalidations.clear();
        for (const path of pending) await this.reconcilePath(path);
    }

    /**
     * Queue a precise re-check of one vault-relative path on the next sync.
     * Unlike markDirty, this never triggers a full vault walk on its own.
     */
    invalidatePath(path: string): void {
        this.pendingInvalidations.add(path.replace(/\\/g, "/"));
    }

    /**
     * Find the closest indexed term to `word` using Levenshtein distance.
     * Returns undefined if no close match exists.
     */
    suggestCorrection(word: string): string | undefined {
        const target = normalized(word);
        const tol = Math.max(1, autoTolerance(target.length));
        let best: string | undefined;
        let bestDist = tol + 1;

        for (const term of this.termIndex.keys()) {
            if (Math.abs(term.length - target.length) > tol) continue;
            const dist = levenshteinDistance(target, term);
            if (dist < bestDist) {
                bestDist = dist;
                best = term;
            }
        }
        return best && bestDist <= tol ? best : undefined;
    }

    async refresh(): Promise<{ indexed: number; folders: number }> {
        this.reset();
        await this.synchronize();
        return { indexed: this.entries.size, folders: this.folders.size };
    }

    /** Reconciles names and stat fingerprints, parsing only new or changed Markdown files. */
    async synchronize(): Promise<void> {
        const root = getVaultRoot();
        if (this.root !== root) this.reset();
        this.root = root;
        this.pendingInvalidations.clear();

        const seen = new Set<string>();
        const folders = new Set<string>();
        await this.scan(root, seen, folders);
        for (const path of [...this.entries.keys()]) {
            if (!seen.has(path)) this.removeEntry(path);
        }
        this.folders = folders;
        this.initialized = true;
        this.dirty = false;
    }

    // ── Incremental term-index maintenance ───────────────────────────

    private addTerm(token: string, path: string): void {
        let set = this.termIndex.get(token);
        if (!set) {
            set = new Set();
            this.termIndex.set(token, set);
        }
        set.add(path);
    }

    private removeTerm(token: string, path: string): void {
        const set = this.termIndex.get(token);
        if (!set) return;
        set.delete(path);
        if (set.size === 0) this.termIndex.delete(token);
    }

    /** Index one entry's filename/title/tags/aliases/headings/content tokens. */
    private addToTermIndex(entry: KnowledgeEntry): void {
        const stem = normalized(entry.filename.slice(0, -entry.extension.length || undefined));
        for (const token of tokenize(stem)) this.addTerm(token, entry.path);
        if (entry.title) for (const token of tokenize(entry.title)) this.addTerm(token, entry.path);
        for (const tag of entry.tags) for (const token of tokenize(tag)) this.addTerm(token, entry.path);
        for (const alias of entry.aliases) for (const token of tokenize(alias)) this.addTerm(token, entry.path);
        for (const heading of entry.headings) for (const token of tokenize(heading)) this.addTerm(token, entry.path);
        for (const token of entry.contentTokens.keys()) this.addTerm(token, entry.path);
    }

    /** Remove one entry's tokens from the term index. */
    private removeFromTermIndex(entry: KnowledgeEntry): void {
        const stem = normalized(entry.filename.slice(0, -entry.extension.length || undefined));
        for (const token of tokenize(stem)) this.removeTerm(token, entry.path);
        if (entry.title) for (const token of tokenize(entry.title)) this.removeTerm(token, entry.path);
        for (const tag of entry.tags) for (const token of tokenize(tag)) this.removeTerm(token, entry.path);
        for (const alias of entry.aliases) for (const token of tokenize(alias)) this.removeTerm(token, entry.path);
        for (const heading of entry.headings) for (const token of tokenize(heading)) this.removeTerm(token, entry.path);
        for (const token of entry.contentTokens.keys()) this.removeTerm(token, entry.path);
    }

    /** Insert or replace an entry, keeping the term index incremental. */
    private upsertEntry(entry: KnowledgeEntry): void {
        const existing = this.entries.get(entry.path);
        if (existing) this.removeFromTermIndex(existing);
        this.entries.set(entry.path, entry);
        this.caseIndex.set(entry.path.toLowerCase(), entry.path);
        this.addToTermIndex(entry);
    }

    /** Remove an entry and its term-index postings. */
    private removeEntry(path: string): void {
        const existing = this.entries.get(path);
        if (existing) this.removeFromTermIndex(existing);
        this.entries.delete(path);
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
        const fullPath = join(root, pendingPath);
        const key = this.entries.has(pendingPath) ? pendingPath : this.caseIndex.get(pendingPath.toLowerCase());
        let info;
        try {
            info = await lstat(fullPath);
        } catch {
            if (key) this.removeEntry(key);
            this.pruneFolderPrefix(pendingPath);
            return;
        }
        if (info.isSymbolicLink()) {
            if (key) this.removeEntry(key);
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
            if (key && this.entries.get(key)?.fingerprint === fingerprint) return;
            await this.indexFile(fullPath, key ?? pendingPath, fingerprint, s.size, s.mtime.toISOString());
        } catch {
            if (key) this.removeEntry(key);
        }
    }

    /** Re-index a folder subtree and prune entries/folders that vanished with it. */
    private async reconcileDirectory(root: string, dirRel: string): Promise<void> {
        const seen = new Set<string>();
        const folders = new Set<string>();
        folders.add(dirRel);
        try {
            await this.scan(join(root, dirRel), seen, folders);
        } catch {
            // Scan raced with a mutation — degrade to a full resync next time
            this.dirty = true;
            return;
        }
        const prefix = `${dirRel.toLowerCase()}/`;
        for (const path of [...this.entries.keys()]) {
            if (path.toLowerCase().startsWith(prefix) && !seen.has(path)) this.removeEntry(path);
        }
        for (const path of [...this.folders]) {
            if (path.toLowerCase().startsWith(prefix) && !folders.has(path)) this.folders.delete(path);
        }
        for (const path of folders) this.folders.add(path);
    }

    /** Drop tracked folder entries under a removed prefix. */
    private pruneFolderPrefix(dirRel: string): void {
        const prefix = `${dirRel.toLowerCase()}/`;
        for (const path of [...this.folders]) {
            if (path.toLowerCase().startsWith(prefix)) this.folders.delete(path);
        }
    }

    /**
     * Use the term index to find candidate paths that match any of the query tokens.
     * Returns null if the term index cannot help (caller should scan all entries).
     */
    private getCandidatesFromTermIndex(queryTokens: string[]): Set<string> | null {
        if (queryTokens.length === 0) return null;
        const candidates = new Set<string>();
        let found = false;
        for (const token of queryTokens) {
            const paths = this.termIndex.get(token);
            if (paths) {
                found = true;
                for (const p of paths) candidates.add(p);
            }
        }
        return found ? candidates : null;
    }

    getEntries(folder = "."): KnowledgeEntry[] {
        return [...this.entries.values()]
            .filter((entry) => isWithinFolder(entry.path, folder))
            .sort((a, b) => a.path.localeCompare(b.path, "en"));
    }

    getFolders(folder = ".", recursive = true): string[] {
        const prefix = folder === "." ? "" : `${folder}/`;
        return [...this.folders]
            .filter((path) => {
                if (path === folder || !isWithinFolder(path, folder)) return false;
                return recursive || !path.slice(prefix.length).includes("/");
            })
            .sort((a, b) => a.localeCompare(b, "en"));
    }

    discover(query: string, folder: string, fields: DiscoveryField[], types: ResourceType[]): DiscoveryResult[] {
        const q = normalized(query);
        const queryTokens = tokenize(query);
        const results: DiscoveryResult[] = [];

        // Use term index to short-circuit when possible
        const indexedCandidates = this.getCandidatesFromTermIndex(queryTokens);

        if (types.includes("file")) {
            const entriesToSearch = indexedCandidates
                ? this.getEntries(folder).filter((e) => indexedCandidates.has(e.path))
                : this.getEntries(folder);
            for (const entry of entriesToSearch) {
                const matched = new Set<DiscoveryField>();
                let score = 0;
                const file = normalized(entry.filename);
                const stem = normalized(entry.filename.slice(0, -entry.extension.length || undefined));
                const path = normalized(entry.path);
                const title = normalized(entry.title ?? "");
                const aliases = entry.aliases.map(normalized);
                const tags = entry.tags.map(normalized);
                const headings = entry.headings.map(normalized);

                if (fields.includes("filename")) {
                    if (file === q || stem === q) {
                        score = Math.max(score, 1);
                        matched.add("filename");
                    } else if (file.includes(q)) {
                        score = Math.max(score, 0.86);
                        matched.add("filename");
                    } else if (fuzzyFieldMatch(stem, q)) {
                        score = Math.max(score, 0.83);
                        matched.add("filename");
                    }
                }
                if (fields.includes("title") && title) {
                    if (title === q) score = Math.max(score, 0.98);
                    else if (title.includes(q)) score = Math.max(score, 0.84);
                    else if (fuzzyFieldMatch(title, q)) score = Math.max(score, 0.81);
                    if (title.includes(q) || fuzzyFieldMatch(title, q)) matched.add("title");
                }
                if (fields.includes("aliases") && aliases.some((value) => value === q)) {
                    score = Math.max(score, 0.96);
                    matched.add("aliases");
                } else if (fields.includes("aliases") && aliases.some((value) => value.includes(q))) {
                    score = Math.max(score, 0.82);
                    matched.add("aliases");
                } else if (fields.includes("aliases") && aliases.some((value) => fuzzyFieldMatch(value, q))) {
                    score = Math.max(score, 0.79);
                    matched.add("aliases");
                }
                if (fields.includes("tags") && tags.some((value) => value === q)) {
                    score = Math.max(score, 0.94);
                    matched.add("tags");
                } else if (fields.includes("tags") && tags.some((value) => value.includes(q))) {
                    score = Math.max(score, 0.8);
                    matched.add("tags");
                } else if (fields.includes("tags") && tags.some((value) => fuzzyFieldMatch(value, q))) {
                    score = Math.max(score, 0.77);
                    matched.add("tags");
                }
                if (fields.includes("path") && path.includes(q)) {
                    score = Math.max(score, 0.78);
                    matched.add("path");
                } else if (fields.includes("path") && fuzzyFieldMatch(path, q)) {
                    score = Math.max(score, 0.73);
                    matched.add("path");
                }
                if (fields.includes("headings") && headings.some((value) => value.includes(q))) {
                    score = Math.max(score, 0.72);
                    matched.add("headings");
                } else if (fields.includes("headings") && headings.some((value) => fuzzyFieldMatch(value, q))) {
                    score = Math.max(score, 0.67);
                    matched.add("headings");
                }
                if (
                    fields.includes("content") &&
                    queryTokens.length &&
                    queryTokens.every((token) => entry.contentTokens.has(token))
                ) {
                    const frequency = queryTokens.reduce(
                        (sum, token) => sum + (entry.contentTokens.get(token) ?? 0),
                        0,
                    );
                    score = Math.max(score, Math.min(0.69, 0.58 + Math.log1p(frequency) / 20));
                    matched.add("content");
                }

                if (matched.size) {
                    // Small bounded corroboration bonus; primary match priority remains dominant.
                    score = Math.min(1, score + Math.min(0.015, (matched.size - 1) * 0.005));
                    results.push({
                        path: entry.path,
                        filename: entry.filename,
                        type: "file",
                        title: entry.title,
                        tags: entry.tags,
                        aliases: entry.aliases,
                        score: Number(score.toFixed(4)),
                        matched_on: fields.filter((field) => matched.has(field)),
                        preview: entry.preview,
                    });
                }
            }
        }

        if (types.includes("folder")) {
            for (const path of this.getFolders(folder)) {
                const name = basename(path);
                const exact = normalized(name) === q;
                const nameMatch = fields.includes("filename") && normalized(name).includes(q);
                const pathMatch = fields.includes("path") && normalized(path).includes(q);
                if (nameMatch || pathMatch)
                    results.push({
                        path,
                        filename: name,
                        type: "folder",
                        score: exact ? 1 : nameMatch ? 0.86 : 0.78,
                        matched_on: nameMatch ? ["filename"] : ["path"],
                    });
            }
        }

        return results.sort(
            (a, b) => b.score - a.score || a.path.localeCompare(b.path, "en") || a.type.localeCompare(b.type),
        );
    }

    /** Per-directory I/O width for scans (bounded, not sequential, not unbounded). */
    private static readonly SCAN_WIDTH = 16;

    private async scan(dir: string, seen: Set<string>, folders: Set<string>): Promise<void> {
        let items;
        try {
            items = await readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        const subdirs: string[] = [];
        const files: { fullPath: string; path: string; name: string }[] = [];
        for (const item of items) {
            if (SKIPPED_DIRECTORIES.has(item.name)) continue;
            const fullPath = join(dir, item.name);
            if (item.isDirectory()) {
                subdirs.push(fullPath);
            } else if (item.isFile()) {
                files.push({ fullPath, path: relativePath(this.root, fullPath), name: item.name });
            }
        }
        // Stat/read files with bounded concurrency
        for (let i = 0; i < files.length; i += KnowledgeIndex.SCAN_WIDTH) {
            await Promise.all(
                files.slice(i, i + KnowledgeIndex.SCAN_WIDTH).map(async ({ fullPath, path, name }) => {
                    try {
                        // Symlink defense: never index symlinks or junctions
                        if ((await lstat(fullPath)).isSymbolicLink()) return;
                        seen.add(path);
                        const info = await stat(fullPath);
                        const fingerprint = `${info.mtimeMs}:${info.size}`;
                        if (this.entries.get(path)?.fingerprint === fingerprint) return;
                        if (extname(name).toLowerCase() === ".md") {
                            await this.indexFile(fullPath, path, fingerprint, info.size, info.mtime.toISOString());
                        } else {
                            this.upsertEntry({
                                path,
                                filename: basename(path),
                                extension: extname(path).toLowerCase(),
                                folder: dirname(path).replace(/\\/g, "/") === "." ? "" : dirname(path).replace(/\\/g, "/"),
                                tags: [],
                                aliases: [],
                                headings: [],
                                size: info.size,
                                modified: info.mtime.toISOString(),
                                contentTokens: new Map(),
                                fingerprint,
                            });
                        }
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
                    // Symlink defense: never recurse into symlinks or junctions
                    if ((await lstat(subdir)).isSymbolicLink()) return;
                    folders.add(relativePath(this.root, subdir));
                    await this.scan(subdir, seen, folders);
                } catch {
                    // Skip inaccessible directories
                }
            }),
        );
    }

    private async indexFile(
        fullPath: string,
        path: string,
        fingerprint: string,
        size: number,
        modified: string,
    ): Promise<void> {
        try {
            const raw = await readFile(fullPath, "utf-8");
            const parsed = parseFrontmatter(raw);
            const headings = [...parsed.content.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)].map((match) => match[1].trim());
            const titleValue = parsed.frontmatter.title;
            const title = typeof titleValue === "string" && titleValue.trim() ? titleValue.trim() : undefined;
            this.upsertEntry({
                path,
                filename: basename(path),
                extension: extname(path).toLowerCase(),
                folder: dirname(path).replace(/\\/g, "/") === "." ? "" : dirname(path).replace(/\\/g, "/"),
                title,
                tags: stringList(parsed.frontmatter.tags),
                aliases: stringList(parsed.frontmatter.aliases),
                headings,
                size,
                modified,
                preview: preview(parsed.content),
                contentTokens: contentTokenMap(parsed.content),
                fingerprint,
            });
        } catch {
            this.removeEntry(path);
        }
    }
}

export const knowledgeIndex = new KnowledgeIndex();
