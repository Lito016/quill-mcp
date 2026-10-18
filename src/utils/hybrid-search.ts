/**
 * Hybrid search combining BM25 full-text search with semantic TF-IDF embeddings.
 *
 * Normalizes both score types to [0, 1] and combines them using a weighted
 * formula: final_score = alpha * bm25 + (1 - alpha) * semantic.
 */

import { searchIndex, type IndexedDocument } from "./search-index.js";
import { vectorStore } from "./vector-store.js";
import { logger } from "./logger.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface HybridSearchResult {
    /** Vault-relative path */
    path: string;
    /** Combined hybrid score [0, 1] */
    score: number;
    /** Normalized BM25 component [0, 1] */
    bm25_score: number;
    /** Semantic cosine similarity component [0, 1] */
    semantic_score: number;
    /** Content preview (first ~120 chars) */
    preview: string;
    /** Normalized tags from frontmatter */
    tags: string[];
    /** ISO modified timestamp */
    modified: string;
}

export interface HybridSearchOptions {
    /** Search query text */
    query: string;
    /** Maximum results to return (default: 10) */
    top_k?: number;
    /** BM25 vs semantic weight: 0 = pure semantic, 1 = pure BM25 (default: 0.5) */
    alpha?: number;
    /** Minimum combined score threshold (default: 0.0) */
    min_score?: number;
    /** Filter by project directory (vault-relative path) */
    project?: string;
    /** Filter by tags */
    tags?: string[];
    /** Boost recently modified notes (default: false) */
    boost_recent?: boolean;
}

export interface HybridSimilarOptions {
    /** Vault-relative path to the reference note */
    path: string;
    /** Maximum results to return (default: 10) */
    top_k?: number;
    /** BM25 vs semantic weight (default: 0.5) */
    alpha?: number;
    /** Minimum combined score threshold (default: 0.0) */
    min_score?: number;
    /** Filter by project directory */
    project?: string;
    /** Filter by tags */
    tags?: string[];
}

// ─── Constants ───────────────────────────────────────────────────────

/** Timeout for loading each index (ms) */
const INDEX_TIMEOUT_MS = 5000;

// ─── Score Normalization ─────────────────────────────────────────────

/**
 * Normalize an array of scores to [0, 1] using min-max normalization.
 * Returns an array of the same length with values clamped to [0, 1].
 */
export function normalizeScores(scores: number[]): number[] {
    if (scores.length === 0) return [];
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const range = max - min;
    if (range === 0) {
        // All scores are identical — give them all 1.0 if nonzero, else 0
        return scores.map((s) => (s > 0 ? 1.0 : 0.0));
    }
    return scores.map((s) => Math.max(0, Math.min(1, (s - min) / range)));
}

// ─── Timeout Helper ──────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`${label} timed out after ${ms}ms`));
        }, ms);
        promise.then(
            (val) => {
                clearTimeout(timer);
                resolve(val);
            },
            (err) => {
                clearTimeout(timer);
                reject(err);
            },
        );
    });
}

// ─── Hybrid Search ───────────────────────────────────────────────────

/**
 * Perform hybrid search combining BM25 and semantic similarity.
 *
 * Both indexes are loaded in parallel. If one fails, the search falls
 * back to the available index with a warning logged.
 */
export async function hybridSearch(options: HybridSearchOptions): Promise<HybridSearchResult[]> {
    const {
        query,
        top_k = 10,
        alpha = 0.5,
        min_score = 0.0,
        project,
        tags,
        boost_recent = false,
    } = options;

    if (!query.trim()) return [];

    // Load both indexes in parallel with timeout
    let bm25Ready = false;
    let semanticReady = false;

    const [bm25Result, semanticResult] = await Promise.allSettled([
        withTimeout(searchIndex.ensureSynchronized(), INDEX_TIMEOUT_MS, "BM25 index"),
        withTimeout(vectorStore.ensureIndexed(), INDEX_TIMEOUT_MS, "Semantic index"),
    ]);

    if (bm25Result.status === "fulfilled") {
        bm25Ready = true;
    } else {
        logger.warn("Hybrid search: BM25 index unavailable", { error: bm25Result.reason });
    }

    if (semanticResult.status === "fulfilled") {
        semanticReady = true;
    } else {
        logger.warn("Hybrid search: semantic index unavailable", { error: semanticResult.reason });
    }

    if (!bm25Ready && !semanticReady) {
        return [];
    }

    // ── Gather BM25 candidates ──────────────────────────────────────
    const queryTokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const allDocs = bm25Ready ? searchIndex.getDocuments() : [];

    // Collect all candidate paths from both indexes
    const candidatePaths = new Set<string>();

    // BM25 candidates: filter docs that contain at least one query term
    const bm25RawScores = new Map<string, number>();
    if (bm25Ready && queryTokens.length > 0) {
        const inverted = searchIndex.getInvertedIndex();
        for (const doc of allDocs) {
            if (doc.path.includes(".trash/") || doc.path.includes(".versions/")) continue;
            // Check if doc has any query term
            const hasTerm = queryTokens.some((t) => doc.termFreq.has(t));
            if (hasTerm) {
                const score = searchIndex.bm25Score(doc, queryTokens);
                bm25RawScores.set(doc.path, score);
                candidatePaths.add(doc.path);
            }
        }
    }

    // Semantic candidates
    const semanticRawScores = new Map<string, number>();
    const semanticPreviews = new Map<string, string>();
    if (semanticReady) {
        const queryVector = vectorStore.computeQueryVector(query);
        if (queryVector.length > 0 && !queryVector.every((v) => v === 0)) {
            // Get generous candidates from semantic search
            const semResults = vectorStore.search(queryVector, Math.max(top_k * 3, 30), 0.0);
            for (const r of semResults) {
                semanticRawScores.set(r.path, r.score);
                semanticPreviews.set(r.path, r.preview);
                candidatePaths.add(r.path);
            }
        }
    }

    if (candidatePaths.size === 0) return [];

    // ── Normalize scores ────────────────────────────────────────────
    const allPaths = [...candidatePaths];
    const bm25Values = allPaths.map((p) => bm25RawScores.get(p) ?? 0);
    const semValues = allPaths.map((p) => semanticRawScores.get(p) ?? 0);

    const bm25Norm = normalizeScores(bm25Values);
    const semNorm = normalizeScores(semValues);

    const bm25NormMap = new Map<string, number>();
    const semNormMap = new Map<string, number>();
    for (let i = 0; i < allPaths.length; i++) {
        bm25NormMap.set(allPaths[i], bm25Norm[i]);
        semNormMap.set(allPaths[i], semNorm[i]);
    }

    // ── Combine scores ──────────────────────────────────────────────
    const combined: HybridSearchResult[] = [];

    for (const path of allPaths) {
        const bm25s = bm25NormMap.get(path) ?? 0;
        const semS = semNormMap.get(path) ?? 0;

        // If only one index is available, use it fully
        let finalScore: number;
        if (!bm25Ready) {
            finalScore = semS;
        } else if (!semanticReady) {
            finalScore = bm25s;
        } else {
            finalScore = alpha * bm25s + (1 - alpha) * semS;
        }

        // Boost recently modified notes
        if (boost_recent) {
            const doc = searchIndex.getDocument(path);
            if (doc?.modified) {
                const ageMs = Date.now() - new Date(doc.modified).getTime();
                const ageDays = ageMs / (1000 * 60 * 60 * 24);
                // Exponential decay: recent notes get up to 20% boost
                const recencyBoost = 1 + 0.2 * Math.exp(-ageDays / 30);
                finalScore *= recencyBoost;
                // Clamp to [0, 1]
                finalScore = Math.min(1, finalScore);
            }
        }

        if (finalScore < min_score) continue;

        // Gather metadata
        const doc = searchIndex.getDocument(path);
        const preview = semanticPreviews.get(path) ?? doc?.rawContent?.slice(0, 120).replace(/\n/g, " ") ?? "";
        const docTags = doc?.tags ?? [];
        const modified = doc?.modified ?? "";

        combined.push({
            path,
            score: finalScore,
            bm25_score: bm25s,
            semantic_score: semS,
            preview,
            tags: docTags,
            modified,
        });
    }

    // ── Apply filters ───────────────────────────────────────────────
    let filtered = combined;

    if (project) {
        const prefix = project.replace(/\/+$/, "");
        filtered = filtered.filter((r) => r.path === prefix || r.path.startsWith(`${prefix}/`));
    }

    if (tags && tags.length > 0) {
        const lowerTags = tags.map((t) => t.toLowerCase());
        filtered = filtered.filter((r) => lowerTags.every((t) => r.tags.includes(t)));
    }

    // ── Sort and limit ──────────────────────────────────────────────
    filtered.sort((a, b) => b.score - a.score);
    return filtered.slice(0, top_k);
}

// ─── Hybrid Similar ──────────────────────────────────────────────────

/**
 * Find notes similar to a reference note using hybrid BM25 + semantic approach.
 *
 * Combines content-based semantic similarity with keyword overlap scoring.
 */
export async function hybridSearchSimilar(options: HybridSimilarOptions): Promise<HybridSearchResult[]> {
    const { path, top_k = 10, alpha = 0.5, min_score = 0.0, project, tags } = options;

    // Load both indexes in parallel
    let bm25Ready = false;
    let semanticReady = false;

    const [bm25Result, semanticResult] = await Promise.allSettled([
        withTimeout(searchIndex.ensureSynchronized(), INDEX_TIMEOUT_MS, "BM25 index"),
        withTimeout(vectorStore.ensureIndexed(), INDEX_TIMEOUT_MS, "Semantic index"),
    ]);

    if (bm25Result.status === "fulfilled") bm25Ready = true;
    if (semanticResult.status === "fulfilled") semanticReady = true;

    if (!bm25Ready && !semanticReady) return [];

    // Get the reference document
    const refDoc = searchIndex.getDocument(path);
    if (!refDoc && !semanticReady) return [];

    // ── BM25 overlap: use reference doc's terms as query ────────────
    const bm25RawScores = new Map<string, number>();
    if (bm25Ready && refDoc) {
        // Use the top terms from the reference document as query tokens
        const topTerms = [...refDoc.termFreq.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .map(([term]) => term);

        if (topTerms.length > 0) {
            const allDocs = searchIndex.getDocuments();
            for (const doc of allDocs) {
                if (doc.path === path) continue;
                if (doc.path.includes(".trash/") || doc.path.includes(".versions/")) continue;
                const hasTerm = topTerms.some((t) => doc.termFreq.has(t));
                if (hasTerm) {
                    bm25RawScores.set(doc.path, searchIndex.bm25Score(doc, topTerms));
                }
            }
        }
    }

    // ── Semantic similarity ─────────────────────────────────────────
    const semanticRawScores = new Map<string, number>();
    const semanticPreviews = new Map<string, string>();
    if (semanticReady) {
        const simResults = vectorStore.findSimilar(path, Math.max(top_k * 3, 30), 0.0);
        for (const r of simResults) {
            semanticRawScores.set(r.path, r.score);
            semanticPreviews.set(r.path, r.preview);
        }
    }

    // ── Collect all candidate paths ─────────────────────────────────
    const allPathsSet = new Set<string>();
    for (const p of bm25RawScores.keys()) allPathsSet.add(p);
    for (const p of semanticRawScores.keys()) allPathsSet.add(p);

    if (allPathsSet.size === 0) return [];

    const allPaths = [...allPathsSet];

    // ── Normalize and combine ───────────────────────────────────────
    const bm25Values = allPaths.map((p) => bm25RawScores.get(p) ?? 0);
    const semValues = allPaths.map((p) => semanticRawScores.get(p) ?? 0);

    const bm25Norm = normalizeScores(bm25Values);
    const semNorm = normalizeScores(semValues);

    const bm25NormMap = new Map<string, number>();
    const semNormMap = new Map<string, number>();
    for (let i = 0; i < allPaths.length; i++) {
        bm25NormMap.set(allPaths[i], bm25Norm[i]);
        semNormMap.set(allPaths[i], semNorm[i]);
    }

    const combined: HybridSearchResult[] = [];

    for (const candidatePath of allPaths) {
        const bm25s = bm25NormMap.get(candidatePath) ?? 0;
        const semS = semNormMap.get(candidatePath) ?? 0;

        let finalScore: number;
        if (!bm25Ready) {
            finalScore = semS;
        } else if (!semanticReady) {
            finalScore = bm25s;
        } else {
            finalScore = alpha * bm25s + (1 - alpha) * semS;
        }

        if (finalScore < min_score) continue;

        const doc = searchIndex.getDocument(candidatePath);
        const preview = semanticPreviews.get(candidatePath) ?? doc?.rawContent?.slice(0, 120).replace(/\n/g, " ") ?? "";

        combined.push({
            path: candidatePath,
            score: finalScore,
            bm25_score: bm25s,
            semantic_score: semS,
            preview,
            tags: doc?.tags ?? [],
            modified: doc?.modified ?? "",
        });
    }

    // ── Apply filters ───────────────────────────────────────────────
    let filtered = combined;

    if (project) {
        const prefix = project.replace(/\/+$/, "");
        filtered = filtered.filter((r) => r.path === prefix || r.path.startsWith(`${prefix}/`));
    }

    if (tags && tags.length > 0) {
        const lowerTags = tags.map((t) => t.toLowerCase());
        filtered = filtered.filter((r) => lowerTags.every((t) => r.tags.includes(t)));
    }

    filtered.sort((a, b) => b.score - a.score);
    return filtered.slice(0, top_k);
}
