/**
 * In-memory metadata index for all memory files in the vault.
 * Scans frontmatter of all .md files, builds primary cache + secondary indexes + BM25 inverted index.
 * Lazy initialization, incremental updates via watcher notifications.
 */

import { readdir, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { getVaultRoot } from "./vault.js";
import { parseFrontmatter } from "./frontmatter.js";
import { getConfig } from "./config.js";
import { isMemoryFrontmatter } from "./memory-schema.js";
import type { MemoryMetadata, MemoryType, MemoryStatus } from "./memory-schema.js";

export interface MemoryFilter {
    project?: string;
    type?: MemoryType | MemoryType[];
    status?: MemoryStatus | MemoryStatus[];
    entity?: string;
    tags?: string[];
    minConfidence?: number;
    maxConfidence?: number;
    excludeIds?: string[];
}

export interface InvertedIndex {
    postings: Map<string, Map<string, { tf: number }>>;
    docLengths: Map<string, number>;
    avgDocLength: number;
    docCount: number;
}

export interface IndexStats {
    totalMemories: number;
    byProject: Record<string, number>;
    byType: Record<string, number>;
    byStatus: Record<string, number>;
    lastRebuild: string;
    isStale: boolean;
}

// BM25 stopwords (common English words to ignore in indexing)
const STOPWORDS = new Set([
    "a",
    "an",
    "the",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "can",
    "shall",
    "to",
    "of",
    "in",
    "for",
    "on",
    "with",
    "at",
    "by",
    "from",
    "as",
    "into",
    "through",
    "during",
    "before",
    "after",
    "above",
    "below",
    "between",
    "under",
    "again",
    "then",
    "once",
    "here",
    "there",
    "when",
    "where",
    "why",
    "how",
    "all",
    "each",
    "every",
    "both",
    "few",
    "more",
    "most",
    "other",
    "some",
    "such",
    "no",
    "not",
    "only",
    "own",
    "same",
    "so",
    "than",
    "too",
    "very",
    "just",
    "and",
    "but",
    "or",
    "if",
    "while",
    "this",
    "that",
    "these",
    "those",
    "it",
    "its",
    "he",
    "she",
    "they",
    "we",
]);

class MetadataIndexImpl {
    private memories: Map<string, MemoryMetadata> = new Map();
    private byProject: Map<string, Set<string>> = new Map();
    private byType: Map<string, Set<string>> = new Map();
    private byStatus: Map<string, Set<string>> = new Map();
    private byEntity: Map<string, Set<string>> = new Map();
    private invertedIndex: InvertedIndex = {
        postings: new Map(),
        docLengths: new Map(),
        avgDocLength: 0,
        docCount: 0,
    };
    private initialized = false;
    private stale = false;
    private lastRebuild = "";

    /**
     * Initialize the index by scanning the vault.
     */
    async initialize(): Promise<void> {
        await this.rebuild();
    }

    /**
     * Invalidate the entire index or a specific entry.
     */
    invalidate(filePath?: string): void {
        if (filePath) {
            const id = this.getIdFromPath(filePath);
            this.removeEntry(id);
        } else {
            this.memories.clear();
            this.byProject.clear();
            this.byType.clear();
            this.byStatus.clear();
            this.byEntity.clear();
            this.invertedIndex = { postings: new Map(), docLengths: new Map(), avgDocLength: 0, docCount: 0 };
        }
        this.stale = true;
    }

    /**
     * Rebuild the entire index from disk.
     */
    async rebuild(): Promise<void> {
        this.memories.clear();
        this.byProject.clear();
        this.byType.clear();
        this.byStatus.clear();
        this.byEntity.clear();
        this.invertedIndex = { postings: new Map(), docLengths: new Map(), avgDocLength: 0, docCount: 0 };

        const vaultRoot = getVaultRoot();
        const config = getConfig();
        const memoriesDir = config.memory.directories.memories;

        await this.scanDirectory(vaultRoot, vaultRoot);

        // Also scan the configured memories subdirectory if it exists
        const memDir = join(vaultRoot, memoriesDir);
        if (memDir !== vaultRoot) {
            await this.scanDirectory(memDir, vaultRoot);
        }

        // Compute average document length for BM25
        const lengths = [...this.invertedIndex.docLengths.values()];
        this.invertedIndex.avgDocLength = lengths.length > 0 ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
        this.invertedIndex.docCount = this.memories.size;

        this.initialized = true;
        this.stale = false;
        this.lastRebuild = new Date().toISOString();
    }

    /**
     * Update a single entry in the index.
     */
    async updateEntry(filePath: string): Promise<void> {
        const vaultRoot = getVaultRoot();
        await this.indexFile(filePath, vaultRoot);
        // Recompute aggregate BM25 stats after incremental update
        const lengths = [...this.invertedIndex.docLengths.values()];
        this.invertedIndex.avgDocLength = lengths.length > 0 ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
        this.invertedIndex.docCount = this.memories.size;
        this.stale = false;
    }

    // === QUERY METHODS ===

    getById(id: string): MemoryMetadata | undefined {
        return this.memories.get(id);
    }

    getByProject(project: string): MemoryMetadata[] {
        const ids = this.byProject.get(project.toLowerCase());
        if (!ids) return [];
        return [...ids].map((id) => this.memories.get(id)!).filter(Boolean);
    }

    getByType(type: MemoryType): MemoryMetadata[] {
        const ids = this.byType.get(type);
        if (!ids) return [];
        return [...ids].map((id) => this.memories.get(id)!).filter(Boolean);
    }

    getByStatus(status: MemoryStatus): MemoryMetadata[] {
        const ids = this.byStatus.get(status);
        if (!ids) return [];
        return [...ids].map((id) => this.memories.get(id)!).filter(Boolean);
    }

    getByEntity(entity: string): MemoryMetadata[] {
        const normalized = entity.toLowerCase();
        const ids = this.byEntity.get(normalized);
        if (!ids) return [];
        return [...ids].map((id) => this.memories.get(id)!).filter(Boolean);
    }

    /**
     * Query memories with a filter.
     */
    query(filter: MemoryFilter): MemoryMetadata[] {
        let results = [...this.memories.values()];

        if (filter.project) {
            results = results.filter((m) => m.project.toLowerCase() === filter.project!.toLowerCase());
        }
        if (filter.type) {
            const types = Array.isArray(filter.type) ? filter.type : [filter.type];
            results = results.filter((m) => types.includes(m.type));
        }
        if (filter.status) {
            const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
            results = results.filter((m) => statuses.includes(m.status));
        }
        if (filter.entity) {
            results = results.filter((m) => m.entity?.toLowerCase() === filter.entity!.toLowerCase());
        }
        if (filter.tags && filter.tags.length > 0) {
            const tagSet = new Set(filter.tags.map((t) => t.toLowerCase()));
            results = results.filter((m) => m.tags.some((t) => tagSet.has(t.toLowerCase())));
        }
        if (filter.minConfidence !== undefined) {
            results = results.filter((m) => m.confidence >= filter.minConfidence!);
        }
        if (filter.maxConfidence !== undefined) {
            results = results.filter((m) => m.confidence <= filter.maxConfidence!);
        }
        if (filter.excludeIds && filter.excludeIds.length > 0) {
            const excludeSet = new Set(filter.excludeIds);
            results = results.filter((m) => !excludeSet.has(m.id));
        }

        return results;
    }

    // === BM25 INDEX ACCESS ===

    getInvertedIndex(): InvertedIndex {
        return this.invertedIndex;
    }

    getDocLength(memoryId: string): number {
        return this.invertedIndex.docLengths.get(memoryId) ?? 0;
    }

    getAvgDocLength(): number {
        return this.invertedIndex.avgDocLength;
    }

    // === STATS ===

    getStats(): IndexStats {
        const byProject: Record<string, number> = {};
        for (const [project, ids] of this.byProject) {
            byProject[project] = ids.size;
        }
        const byType: Record<string, number> = {};
        for (const [type, ids] of this.byType) {
            byType[type] = ids.size;
        }
        const byStatus: Record<string, number> = {};
        for (const [status, ids] of this.byStatus) {
            byStatus[status] = ids.size;
        }

        return {
            totalMemories: this.memories.size,
            byProject,
            byType,
            byStatus,
            lastRebuild: this.lastRebuild,
            isStale: this.stale,
        };
    }

    isInitialized(): boolean {
        return this.initialized;
    }

    // === INTERNAL METHODS ===

    private async scanDirectory(dir: string, vaultRoot: string): Promise<void> {
        const config = getConfig();
        const skipDirs = new Set([
            ".trash",
            ".versions",
            ".quill-sessions",
            ".quill",
            "node_modules",
            config.memory.directories.archive,
        ]);

        try {
            const items = await readdir(dir, { withFileTypes: true });
            for (const item of items) {
                if (skipDirs.has(item.name)) continue;
                const fullPath = join(dir, item.name);
                // Symlink defense: never recurse into symbolic links
                try {
                    const entryStat = await lstat(fullPath);
                    if (entryStat.isSymbolicLink()) continue;
                } catch {
                    continue;
                }

                if (item.isDirectory()) {
                    await this.scanDirectory(fullPath, vaultRoot);
                } else if (item.name.endsWith(".md")) {
                    await this.indexFile(fullPath, vaultRoot);
                }
            }
        } catch {
            // Skip unreadable directories
        }
    }

    private async indexFile(fullPath: string, vaultRoot: string): Promise<void> {
        try {
            const content = await readFile(fullPath, "utf-8");
            const { frontmatter, content: body } = parseFrontmatter(content);

            // Only index files with memory frontmatter
            if (!isMemoryFrontmatter(frontmatter)) return;

            const relPath = fullPath.startsWith(vaultRoot)
                ? fullPath.slice(vaultRoot.length + 1).replace(/\\/g, "/")
                : fullPath;

            const id = frontmatter.id as string;
            const words = body
                .trim()
                .split(/\s+/)
                .filter((w) => w.length > 0);
            const preview = body.trim().slice(0, 200);

            // Parse source from nested object or flat fields
            let sourceType = (frontmatter.source_type as string) ?? "AGENT";
            let sourceReference = frontmatter.source_reference as string | undefined;
            if (typeof frontmatter.source === "object" && frontmatter.source !== null) {
                const source = frontmatter.source as Record<string, unknown>;
                sourceType = (source.type as string) ?? sourceType;
                sourceReference = (source.reference as string) ?? sourceReference;
            }

            const metadata: MemoryMetadata = {
                id,
                type: frontmatter.type as MemoryType,
                status: ((frontmatter.status as string) ?? "ACTIVE") as MemoryStatus,
                confidence: typeof frontmatter.confidence === "number" ? frontmatter.confidence : 0.8,
                project: (frontmatter.project as string) ?? "default",
                created: (frontmatter.created as string) ?? new Date().toISOString(),
                updated: (frontmatter.updated as string) ?? new Date().toISOString(),
                source_type: sourceType as MemoryMetadata["source_type"],
                source_reference: sourceReference,
                importance: ((frontmatter.importance as string) ?? "NORMAL") as MemoryMetadata["importance"],
                entity: frontmatter.entity as string | undefined,
                supersedes: frontmatter.supersedes as string | undefined,
                superseded_by: frontmatter.superseded_by as string | undefined,
                related: Array.isArray(frontmatter.related) ? frontmatter.related : [],
                tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
                filePath: relPath,
                contentPreview: preview,
                wordCount: words.length,
                lastIndexed: new Date().toISOString(),
            };

            // Remove old entry if updating
            this.removeEntry(id);

            // Add to primary store
            this.memories.set(id, metadata);

            // Update secondary indexes
            this.addToIndex(this.byProject, metadata.project.toLowerCase(), id);
            this.addToIndex(this.byType, metadata.type, id);
            this.addToIndex(this.byStatus, metadata.status, id);
            if (metadata.entity) {
                this.addToIndex(this.byEntity, metadata.entity.toLowerCase(), id);
            }

            // Update inverted index (BM25)
            this.indexDocument(id, body);
        } catch {
            // Skip unreadable or malformed files
        }
    }

    private removeEntry(id: string): void {
        const existing = this.memories.get(id);
        if (!existing) return;

        this.removeFromIndex(this.byProject, existing.project.toLowerCase(), id);
        this.removeFromIndex(this.byType, existing.type, id);
        this.removeFromIndex(this.byStatus, existing.status, id);
        if (existing.entity) {
            this.removeFromIndex(this.byEntity, existing.entity.toLowerCase(), id);
        }
        this.invertedIndex.docLengths.delete(id);

        // Remove from postings
        for (const [, docMap] of this.invertedIndex.postings) {
            docMap.delete(id);
        }

        this.memories.delete(id);
    }

    private addToIndex(index: Map<string, Set<string>>, key: string, id: string): void {
        if (!index.has(key)) {
            index.set(key, new Set());
        }
        index.get(key)!.add(id);
    }

    private removeFromIndex(index: Map<string, Set<string>>, key: string, id: string): void {
        const set = index.get(key);
        if (set) {
            set.delete(id);
            if (set.size === 0) index.delete(key);
        }
    }

    /**
     * Tokenize text and add to the inverted index.
     */
    private indexDocument(docId: string, text: string): void {
        const tokens = this.tokenize(text);
        this.invertedIndex.docLengths.set(docId, tokens.length);

        // Count term frequencies
        const tf = new Map<string, number>();
        for (const token of tokens) {
            tf.set(token, (tf.get(token) ?? 0) + 1);
        }

        // Add to postings
        for (const [token, count] of tf) {
            if (!this.invertedIndex.postings.has(token)) {
                this.invertedIndex.postings.set(token, new Map());
            }
            this.invertedIndex.postings.get(token)!.set(docId, { tf: count });
        }
    }

    /**
     * Tokenize text into lowercase words, removing stopwords and short tokens.
     */
    private tokenize(text: string): string[] {
        return text
            .toLowerCase()
            .replace(/[^\w\s]/g, " ")
            .split(/\s+/)
            .filter((w) => w.length > 1 && !STOPWORDS.has(w));
    }

    private getIdFromPath(filePath: string): string {
        // Try to find by file path
        for (const [id, meta] of this.memories) {
            if (meta.filePath === filePath) return id;
        }
        return "";
    }
}

// Singleton instance
export const metadataIndex = new MetadataIndexImpl();
export type { MetadataIndexImpl as MetadataIndex };
