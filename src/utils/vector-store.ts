/**
 * In-memory vector store with cosine similarity search.
 *
 * Maintains a vector index loaded from disk embeddings and provides
 * fast similarity search across all indexed document chunks.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readdir, stat, lstat } from "node:fs/promises";
import { relative } from "node:path";
import { getVaultRoot } from "./vault.js";
import { logger } from "./logger.js";
import {
    type ChunkedDocument,
    type EmbeddingData,
    chunkDocument,
    chunkKey,
    buildVocabulary,
    computeAllTfIdf,
    saveEmbedding,
    loadEmbedding,
    removeEmbeddings,
    listEmbeddingFiles,
    clearEmbeddingCache,
    hashContent,
    isExcludedPath,
    getEmbeddingsDir,
    tokenize,
} from "./embeddings.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface VectorDocument {
    /** Unique key: path::chunkIndex */
    key: string;
    /** Vault-relative path */
    path: string;
    /** Chunk index within the document */
    chunkIndex: number;
    /** Total chunks for this document */
    totalChunks: number;
    /** The TF-IDF vector (L2-normalized) */
    vector: number[];
    /** Content hash for staleness detection */
    contentHash: string;
    /** Preview text (first 200 chars of chunk) */
    preview: string;
}

export interface SearchResult {
    /** Vault-relative path */
    path: string;
    /** Chunk index */
    chunkIndex: number;
    /** Total chunks */
    totalChunks: number;
    /** Cosine similarity score (0-1) */
    score: number;
    /** Text preview */
    preview: string;
}

export interface IndexStatus {
    isIndexed: boolean;
    totalFiles: number;
    indexedFiles: number;
    totalChunks: number;
    indexedChunks: number;
    vocabularySize: number;
    lastIndexed: string | null;
}

// ─── Constants ───────────────────────────────────────────────────────

const SKIP_DIRS = new Set([".trash", ".versions", ".embeddings", ".quill-sessions", ".git", "node_modules"]);

/** Max concurrent file reads during indexing */
const INDEX_CONCURRENCY = 8;

// ─── Vector Store ────────────────────────────────────────────────────

class VectorStore {
    private documents = new Map<string, VectorDocument>();
    private vocabulary: string[] = [];
    private lastIndexed: string | null = null;
    private indexing = false;
    private indexPromise: Promise<void> | null = null;

    // ── Public API ────────────────────────────────────────────────────

    /**
     * Add a single document to the vector index.
     * Computes embedding if not cached, then adds to in-memory index.
     */
    async addDocument(path: string, content: string): Promise<void> {
        const chunks = chunkDocument(path, content);

        // Build vocabulary including this document's terms
        const existingChunks = this.getChunksForPath(path);
        const allChunks = [...existingChunks.map((c) => ({
            path: c.path,
            chunkIndex: c.chunkIndex,
            totalChunks: c.totalChunks,
            text: c.preview,
            contentHash: c.contentHash,
        })), ...chunks];

        // Recompute vocabulary and vectors for all chunks of this path
        const vocab = buildVocabulary(chunks);
        // Merge with existing vocabulary
        const mergedVocab = this.mergeVocabulary(vocab);
        this.vocabulary = mergedVocab;

        // Compute vectors for new chunks
        const vectors = computeAllTfIdf(chunks, mergedVocab);

        for (const chunk of chunks) {
            const key = chunkKey(chunk.path, chunk.chunkIndex);
            const vector = vectors.get(key) ?? new Array(mergedVocab.length).fill(0);

            // Pad vector if vocabulary grew
            const paddedVector = this.padVector(vector, mergedVocab.length);

            const doc: VectorDocument = {
                key,
                path: chunk.path,
                chunkIndex: chunk.chunkIndex,
                totalChunks: chunk.totalChunks,
                vector: paddedVector,
                contentHash: chunk.contentHash,
                preview: chunk.text.slice(0, 200),
            };

            this.documents.set(key, doc);

            // Cache to disk
            const embData: EmbeddingData = {
                embedding: paddedVector,
                timestamp: new Date().toISOString(),
                contentHash: chunk.contentHash,
                vocabulary: mergedVocab,
                chunkIndex: chunk.chunkIndex,
                totalChunks: chunk.totalChunks,
            };
            await saveEmbedding(path, chunk.chunkIndex, embData);
        }
    }

    /**
     * Remove a document and all its chunks from the index.
     */
    async removeDocument(path: string): Promise<void> {
        const keysToRemove: string[] = [];
        for (const [key, doc] of this.documents) {
            if (doc.path === path) {
                keysToRemove.push(key);
            }
        }
        for (const key of keysToRemove) {
            this.documents.delete(key);
        }
        await removeEmbeddings(path);
    }

    /**
     * Search for documents similar to the query vector.
     */
    search(queryVector: number[], topK: number = 10, minSimilarity: number = 0.0): SearchResult[] {
        if (this.documents.size === 0 || queryVector.length === 0) {
            return [];
        }

        // Pad query vector to match vocabulary size
        const paddedQuery = this.padVector(queryVector, this.vocabulary.length);

        const results: SearchResult[] = [];

        for (const doc of this.documents.values()) {
            const score = cosineSimilarity(paddedQuery, doc.vector);
            if (score >= minSimilarity) {
                results.push({
                    path: doc.path,
                    chunkIndex: doc.chunkIndex,
                    totalChunks: doc.totalChunks,
                    score,
                    preview: doc.preview,
                });
            }
        }

        // Sort by score descending
        results.sort((a, b) => b.score - a.score);

        // Deduplicate by path: keep highest scoring chunk per path
        const seen = new Map<string, SearchResult>();
        for (const result of results) {
            const existing = seen.get(result.path);
            if (!existing || result.score > existing.score) {
                seen.set(result.path, result);
            }
        }

        const deduped = [...seen.values()].sort((a, b) => b.score - a.score);
        return deduped.slice(0, topK);
    }

    /**
     * Search for documents similar to a specific indexed document.
     */
    findSimilar(path: string, topK: number = 10, minSimilarity: number = 0.0): SearchResult[] {
        // Get the first chunk's vector for this path
        const key = chunkKey(path, 0);
        const doc = this.documents.get(key);
        if (!doc) {
            return [];
        }

        // Search using this document's vector, excluding itself
        const results = this.search(doc.vector, topK + 1, minSimilarity);
        return results.filter((r) => r.path !== path).slice(0, topK);
    }

    /**
     * Rebuild the entire index from vault contents.
     */
    async rebuild(): Promise<void> {
        if (this.indexing && this.indexPromise) {
            return this.indexPromise;
        }

        this.indexing = true;
        this.indexPromise = this.doRebuild();

        try {
            await this.indexPromise;
        } finally {
            this.indexing = false;
            this.indexPromise = null;
        }
    }

    /**
     * Ensure the index is built. If already indexed, returns immediately.
     */
    async ensureIndexed(): Promise<void> {
        if (this.documents.size > 0 && this.lastIndexed) {
            return;
        }
        await this.rebuild();
    }

    /**
     * Get indexing status.
     */
    getStatus(): IndexStatus {
        const indexedPaths = new Set<string>();
        for (const doc of this.documents.values()) {
            indexedPaths.add(doc.path);
        }

        return {
            isIndexed: this.documents.size > 0,
            totalFiles: 0, // Will be populated by caller
            indexedFiles: indexedPaths.size,
            totalChunks: 0,
            indexedChunks: this.documents.size,
            vocabularySize: this.vocabulary.length,
            lastIndexed: this.lastIndexed,
        };
    }

    /**
     * Get the current vocabulary.
     */
    getVocabulary(): string[] {
        return [...this.vocabulary];
    }

    /**
     * Get the number of indexed documents.
     */
    size(): number {
        return this.documents.size;
    }

    /**
     * Compute a query vector from text using the current vocabulary.
     */
    computeQueryVector(text: string): number[] {
        const terms = tokenize(text);
        const tf = new Map<string, number>();
        for (const term of terms) {
            tf.set(term, (tf.get(term) ?? 0) + 1);
        }
        const docLen = terms.length || 1;

        const vector: number[] = new Array(this.vocabulary.length).fill(0);
        for (let i = 0; i < this.vocabulary.length; i++) {
            const term = this.vocabulary[i];
            const termFreq = tf.get(term) ?? 0;
            if (termFreq > 0) {
                vector[i] = 1 + Math.log(termFreq / docLen);
            }
        }

        // L2 normalize
        const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
        if (magnitude > 0) {
            for (let i = 0; i < vector.length; i++) {
                vector[i] /= magnitude;
            }
        }

        return vector;
    }

    /**
     * Check if a specific path is indexed.
     */
    isIndexed(path: string): boolean {
        for (const doc of this.documents.values()) {
            if (doc.path === path) return true;
        }
        return false;
    }

    /**
     * Invalidate a specific path (remove from index, will be re-indexed on next search).
     */
    async invalidate(path: string): Promise<void> {
        await this.removeDocument(path);
    }

    /**
     * Reset the entire store. Used in tests.
     */
    reset(): void {
        this.documents.clear();
        this.vocabulary = [];
        this.lastIndexed = null;
        this.indexing = false;
        this.indexPromise = null;
    }

    // ── Private ───────────────────────────────────────────────────────

    private getChunksForPath(path: string): VectorDocument[] {
        const result: VectorDocument[] = [];
        for (const doc of this.documents.values()) {
            if (doc.path === path) {
                result.push(doc);
            }
        }
        return result;
    }

    private mergeVocabulary(newTerms: string[]): string[] {
        const vocabSet = new Set(this.vocabulary);
        for (const term of newTerms) {
            vocabSet.add(term);
        }
        return [...vocabSet].sort();
    }

    /**
     * Pad or truncate a vector to match the target dimension.
     */
    private padVector(vector: number[], targetDim: number): number[] {
        if (vector.length === targetDim) return vector;
        if (vector.length > targetDim) return vector.slice(0, targetDim);
        // Pad with zeros
        return [...vector, ...new Array(targetDim - vector.length).fill(0)];
    }

    private async doRebuild(): Promise<void> {
        const startTime = Date.now();
        logger.info("Vector store: starting full rebuild");

        const root = getVaultRoot();

        // Scan all markdown files
        const files: { fullPath: string; relPath: string }[] = [];
        await this.scanFiles(root, root, files);

        if (files.length === 0) {
            this.lastIndexed = new Date().toISOString();
            logger.info("Vector store: no files to index");
            return;
        }

        // Read all files
        const chunks: ChunkedDocument[] = [];
        for (let i = 0; i < files.length; i += INDEX_CONCURRENCY) {
            const batch = files.slice(i, i + INDEX_CONCURRENCY);
            const results = await Promise.all(
                batch.map(async ({ fullPath, relPath }) => {
                    try {
                        const content = await readFile(fullPath, "utf-8");
                        return chunkDocument(relPath, content);
                    } catch {
                        return [];
                    }
                }),
            );
            for (const result of results) {
                chunks.push(...result);
            }
        }

        if (chunks.length === 0) {
            this.lastIndexed = new Date().toISOString();
            return;
        }

        // Build global vocabulary
        this.vocabulary = buildVocabulary(chunks);

        // Compute all TF-IDF vectors
        const vectors = computeAllTfIdf(chunks, this.vocabulary);

        // Build in-memory index
        this.documents.clear();
        for (const chunk of chunks) {
            const key = chunkKey(chunk.path, chunk.chunkIndex);
            const vector = vectors.get(key) ?? new Array(this.vocabulary.length).fill(0);

            this.documents.set(key, {
                key,
                path: chunk.path,
                chunkIndex: chunk.chunkIndex,
                totalChunks: chunk.totalChunks,
                vector,
                contentHash: chunk.contentHash,
                preview: chunk.text.slice(0, 200),
            });
        }

        // Persist index metadata
        await this.saveIndexMetadata(files.length);

        this.lastIndexed = new Date().toISOString();
        const elapsed = Date.now() - startTime;
        logger.info("Vector store: rebuild complete", {
            files: files.length,
            chunks: chunks.length,
            vocabularySize: this.vocabulary.length,
            elapsedMs: elapsed,
        });
    }

    private async scanFiles(
        root: string,
        dir: string,
        result: { fullPath: string; relPath: string }[],
    ): Promise<void> {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (SKIP_DIRS.has(entry.name)) continue;
            const fullPath = `${dir}/${entry.name}`;

            try {
                const entryStat = await lstat(fullPath);
                if (entryStat.isSymbolicLink()) continue;

                if (entry.isDirectory()) {
                    await this.scanFiles(root, fullPath, result);
                } else if (entry.isFile() && entry.name.endsWith(".md")) {
                    const relPath = relative(root, fullPath).replace(/\\/g, "/");
                    if (!isExcludedPath(relPath)) {
                        result.push({ fullPath, relPath });
                    }
                }
            } catch {
                // Skip inaccessible
            }
        }
    }

    private async saveIndexMetadata(totalFiles: number): Promise<void> {
        const dir = getEmbeddingsDir();
        await mkdir(dir, { recursive: true });
        const meta = {
            lastIndexed: this.lastIndexed,
            totalFiles,
            totalChunks: this.documents.size,
            vocabularySize: this.vocabulary.length,
        };
        await writeFile(join(dir, "index.json"), JSON.stringify(meta, null, 2), "utf-8");
    }
}

// ─── Cosine Similarity ───────────────────────────────────────────────

/**
 * Compute cosine similarity between two vectors.
 * Assumes vectors are already L2-normalized for best performance.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    if (a.length === 0) return 0;

    let dot = 0;
    let magA = 0;
    let magB = 0;

    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(magA) * Math.sqrt(magB);
    if (magnitude === 0) return 0;
    return dot / magnitude;
}

// ─── Singleton ───────────────────────────────────────────────────────

export const vectorStore = new VectorStore();
