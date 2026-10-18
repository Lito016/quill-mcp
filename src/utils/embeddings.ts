/**
 * TF-IDF based embedding computation with disk caching.
 *
 * Uses term frequency–inverse document frequency vectorization as a
 * lightweight alternative to neural embeddings. Vectors are cached to
 * `.embeddings/` at vault root and recomputed only when content changes.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, stat, unlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { getVaultRoot, pathExists } from "./vault.js";
import { logger } from "./logger.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface EmbeddingData {
    /** The TF-IDF vector */
    embedding: number[];
    /** When this embedding was computed */
    timestamp: string;
    /** SHA-256 hash of the content at computation time */
    contentHash: string;
    /** The vocabulary terms (shared across all embeddings) */
    vocabulary: string[];
    /** Chunk index if the note was split into chunks */
    chunkIndex: number;
    /** Total chunks for this document */
    totalChunks: number;
}

export interface ChunkedDocument {
    /** Vault-relative path */
    path: string;
    /** Chunk index (0-based) */
    chunkIndex: number;
    /** Total number of chunks */
    totalChunks: number;
    /** The text content of this chunk */
    text: string;
    /** SHA-256 hash of chunk content */
    contentHash: string;
}

export interface EmbeddingStats {
    totalDocuments: number;
    totalChunks: number;
    indexedChunks: number;
    staleChunks: number;
    vocabularySize: number;
}

// ─── Constants ───────────────────────────────────────────────────────

/** Maximum tokens per chunk before splitting */
const MAX_CHUNK_TOKENS = 512;

/** Directories to exclude from indexing */
const EXCLUDE_DIRS = new Set([".trash", ".versions", ".embeddings", ".quill-sessions", ".git", "node_modules"]);

/** Minimum term length for TF-IDF vocabulary */
const MIN_TERM_LENGTH = 2;

/** Stop words to exclude from vocabulary */
const STOP_WORDS = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "can", "shall", "to", "of", "in", "for",
    "on", "at", "by", "with", "from", "as", "into", "through", "during",
    "before", "after", "above", "below", "between", "under", "again",
    "further", "then", "once", "here", "there", "when", "where", "why",
    "how", "all", "each", "every", "both", "few", "more", "most", "other",
    "some", "such", "no", "nor", "not", "only", "own", "same", "so",
    "than", "too", "very", "just", "because", "but", "and", "or", "if",
    "while", "about", "that", "this", "it", "its", "my", "your", "their",
    "our", "his", "her", "we", "they", "you", "me", "him", "us", "them",
    "what", "which", "who", "whom", "these", "those", "am", "i", "also",
]);

// ─── Tokenizer ───────────────────────────────────────────────────────

const TOKEN_RE = /[\p{L}\p{N}]+/gu;

/**
 * Tokenize text into lowercase terms, filtering stop words and short terms.
 */
export function tokenize(text: string): string[] {
    const raw = text.toLowerCase().match(TOKEN_RE) ?? [];
    return raw.filter((t) => t.length >= MIN_TERM_LENGTH && !STOP_WORDS.has(t));
}

/**
 * Estimate token count (whitespace-delimited words).
 */
export function estimateTokenCount(text: string): number {
    return text.trim().split(/\s+/).filter(Boolean).length;
}

// ─── Content Hashing ─────────────────────────────────────────────────

/**
 * Compute SHA-256 hash of content.
 */
export function hashContent(content: string): string {
    return createHash("sha256").update(content, "utf-8").digest("hex").slice(0, 16);
}

/**
 * Compute a hash for a vault-relative path (used for embedding file names).
 */
export function hashPath(vaultPath: string, relPath: string): string {
    return createHash("sha256").update(`${vaultPath}::${relPath}`, "utf-8").digest("hex").slice(0, 16);
}

// ─── Chunking ────────────────────────────────────────────────────────

/**
 * Split a document into chunks of approximately MAX_CHUNK_TOKENS tokens.
 * Splits on paragraph boundaries (double newlines) when possible.
 */
export function chunkDocument(path: string, content: string): ChunkedDocument[] {
    // Strip frontmatter for embedding purposes
    const body = stripFrontmatter(content);
    const tokenCount = estimateTokenCount(body);

    if (tokenCount <= MAX_CHUNK_TOKENS) {
        return [{
            path,
            chunkIndex: 0,
            totalChunks: 1,
            text: body,
            contentHash: hashContent(body),
        }];
    }

    // Split into paragraphs
    const paragraphs = body.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
    const chunks: ChunkedDocument[] = [];
    let currentText = "";
    let currentTokens = 0;

    for (const para of paragraphs) {
        const paraTokens = estimateTokenCount(para);

        if (currentTokens + paraTokens > MAX_CHUNK_TOKENS && currentTokens > 0) {
            // Flush current chunk
            chunks.push({
                path,
                chunkIndex: chunks.length,
                totalChunks: 0, // Will be updated below
                text: currentText.trim(),
                contentHash: hashContent(currentText.trim()),
            });
            currentText = "";
            currentTokens = 0;
        }

        if (paraTokens > MAX_CHUNK_TOKENS) {
            // Single paragraph exceeds limit: split by sentences
            const sentences = para.split(/(?<=[.!?])\s+/);
            for (const sentence of sentences) {
                const sentTokens = estimateTokenCount(sentence);
                if (currentTokens + sentTokens > MAX_CHUNK_TOKENS && currentTokens > 0) {
                    chunks.push({
                        path,
                        chunkIndex: chunks.length,
                        totalChunks: 0,
                        text: currentText.trim(),
                        contentHash: hashContent(currentText.trim()),
                    });
                    currentText = "";
                    currentTokens = 0;
                }
                currentText += (currentText ? " " : "") + sentence;
                currentTokens += sentTokens;
            }
        } else {
            currentText += (currentText ? "\n\n" : "") + para;
            currentTokens += paraTokens;
        }
    }

    // Flush remaining
    if (currentText.trim()) {
        chunks.push({
            path,
            chunkIndex: chunks.length,
            totalChunks: 0,
            text: currentText.trim(),
            contentHash: hashContent(currentText.trim()),
        });
    }

    // Update totalChunks
    const total = chunks.length;
    for (const chunk of chunks) {
        chunk.totalChunks = total;
    }

    return chunks.length > 0 ? chunks : [{
        path,
        chunkIndex: 0,
        totalChunks: 1,
        text: body,
        contentHash: hashContent(body),
    }];
}

/**
 * Strip YAML frontmatter from markdown content.
 */
function stripFrontmatter(content: string): string {
    if (content.startsWith("---")) {
        const end = content.indexOf("---", 3);
        if (end !== -1) {
            return content.slice(end + 3).trim();
        }
    }
    return content;
}

// ─── TF-IDF Computation ──────────────────────────────────────────────

/**
 * Build a global vocabulary from all chunk texts.
 */
export function buildVocabulary(chunks: ChunkedDocument[]): string[] {
    const df = new Map<string, number>(); // document frequency

    for (const chunk of chunks) {
        const terms = new Set(tokenize(chunk.text));
        for (const term of terms) {
            df.set(term, (df.get(term) ?? 0) + 1);
        }
    }

    // Keep terms that appear in at least 2 documents or all docs if < 100
    const minDf = chunks.length > 100 ? 2 : 1;
    return [...df.entries()]
        .filter(([, freq]) => freq >= minDf)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([term]) => term);
}

/**
 * Compute TF-IDF vector for a single chunk given a vocabulary.
 */
export function computeTfIdf(text: string, vocabulary: string[], totalDocs: number): number[] {
    const terms = tokenize(text);
    const tf = new Map<string, number>();
    for (const term of terms) {
        tf.set(term, (tf.get(term) ?? 0) + 1);
    }

    // Normalize TF by document length
    const docLen = terms.length || 1;

    const vector: number[] = new Array(vocabulary.length);
    for (let i = 0; i < vocabulary.length; i++) {
        const term = vocabulary[i];
        const termFreq = tf.get(term) ?? 0;
        if (termFreq === 0) {
            vector[i] = 0;
        } else {
            // Log-normalized TF
            const normalizedTf = 1 + Math.log(termFreq / docLen);
            // IDF will be applied later when we know the full DF
            // For now, store the TF component
            vector[i] = normalizedTf;
        }
    }
    return vector;
}

/**
 * Compute full TF-IDF vectors for all chunks with proper IDF.
 */
export function computeAllTfIdf(chunks: ChunkedDocument[], vocabulary: string[]): Map<string, number[]> {
    const results = new Map<string, number[]>();
    const N = chunks.length;

    // Compute document frequency for each vocabulary term
    const df = new Map<string, number>();
    for (const chunk of chunks) {
        const terms = new Set(tokenize(chunk.text));
        for (const term of terms) {
            if (vocabulary.includes(term)) {
                df.set(term, (df.get(term) ?? 0) + 1);
            }
        }
    }

    // Pre-compute IDF values
    const idf = new Map<string, number>();
    for (const term of vocabulary) {
        const freq = df.get(term) ?? 0;
        idf.set(term, Math.log((N + 1) / (freq + 1)) + 1); // Smoothed IDF
    }

    // Compute vectors
    for (const chunk of chunks) {
        const terms = tokenize(chunk.text);
        const tf = new Map<string, number>();
        for (const term of terms) {
            tf.set(term, (tf.get(term) ?? 0) + 1);
        }
        const docLen = terms.length || 1;

        const vector: number[] = new Array(vocabulary.length);
        for (let i = 0; i < vocabulary.length; i++) {
            const term = vocabulary[i];
            const termFreq = tf.get(term) ?? 0;
            if (termFreq === 0) {
                vector[i] = 0;
            } else {
                const normalizedTf = 1 + Math.log(termFreq / docLen);
                vector[i] = normalizedTf * (idf.get(term) ?? 1);
            }
        }

        // L2 normalize the vector
        const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
        if (magnitude > 0) {
            for (let i = 0; i < vector.length; i++) {
                vector[i] /= magnitude;
            }
        }

        const key = chunkKey(chunk.path, chunk.chunkIndex);
        results.set(key, vector);
    }

    return results;
}

// ─── Disk Cache ──────────────────────────────────────────────────────

/**
 * Get the embeddings directory path for the current vault.
 */
export function getEmbeddingsDir(): string {
    return join(getVaultRoot(), ".embeddings");
}

/**
 * Save an embedding to disk.
 */
export async function saveEmbedding(
    relPath: string,
    chunkIndex: number,
    data: EmbeddingData,
): Promise<void> {
    const dir = getEmbeddingsDir();
    await mkdir(dir, { recursive: true });
    const pathHash = hashPath(getVaultRoot(), relPath);
    const fileName = `${pathHash}_c${chunkIndex}.json`;
    await writeFile(join(dir, fileName), JSON.stringify(data), "utf-8");
}

/**
 * Load an embedding from disk. Returns null if not found or stale.
 */
export async function loadEmbedding(
    relPath: string,
    chunkIndex: number,
    currentContentHash: string,
): Promise<EmbeddingData | null> {
    const dir = getEmbeddingsDir();
    const pathHash = hashPath(getVaultRoot(), relPath);
    const fileName = `${pathHash}_c${chunkIndex}.json`;
    const filePath = join(dir, fileName);

    try {
        const raw = await readFile(filePath, "utf-8");
        const data: EmbeddingData = JSON.parse(raw);
        if (data.contentHash !== currentContentHash) {
            return null; // Stale
        }
        return data;
    } catch {
        return null;
    }
}

/**
 * Remove embedding files for a given document path.
 */
export async function removeEmbeddings(relPath: string): Promise<void> {
    const dir = getEmbeddingsDir();
    const pathHash = hashPath(getVaultRoot(), relPath);
    const prefix = `${pathHash}_c`;

    try {
        const files = await readdir(dir);
        for (const file of files) {
            if (file.startsWith(prefix) && file.endsWith(".json")) {
                await unlink(join(dir, file));
            }
        }
    } catch {
        // Directory might not exist
    }
}

/**
 * List all embedding files in the cache directory.
 */
export async function listEmbeddingFiles(): Promise<string[]> {
    const dir = getEmbeddingsDir();
    try {
        const files = await readdir(dir);
        return files.filter((f) => f.endsWith(".json"));
    } catch {
        return [];
    }
}

/**
 * Clear all cached embeddings.
 */
export async function clearEmbeddingCache(): Promise<number> {
    const dir = getEmbeddingsDir();
    let count = 0;
    try {
        const files = await readdir(dir);
        for (const file of files) {
            if (file.endsWith(".json")) {
                await unlink(join(dir, file));
                count++;
            }
        }
    } catch {
        // Directory might not exist
    }
    return count;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Create a unique key for a document chunk.
 */
export function chunkKey(path: string, chunkIndex: number): string {
    return `${path}::${chunkIndex}`;
}

/**
 * Check if a path should be excluded from embedding.
 */
export function isExcludedPath(relPath: string): boolean {
    const parts = relPath.split("/");
    return parts.some((part) => EXCLUDE_DIRS.has(part));
}
