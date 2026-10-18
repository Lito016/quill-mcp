/**
 * Version index for fast lookup of note version metadata.
 *
 * Maintains an in-memory cache of version metadata per note, lazily loaded
 * from disk on first access. Invalidated when versions are created or deleted.
 */

import { listVersions, type VersionEntry } from "./version-store.js";

/** Cache: source path -> version entries (newest first). */
const cache = new Map<string, { entries: VersionEntry[]; loadedAt: number }>();

/** Cache TTL in milliseconds (5 minutes). */
const CACHE_TTL = 5 * 60 * 1000;

/**
 * Get cached version entries for a note, loading from disk if needed.
 */
export async function getCachedVersions(sourcePath: string): Promise<VersionEntry[]> {
    const cached = cache.get(sourcePath);
    if (cached && Date.now() - cached.loadedAt < CACHE_TTL) {
        return cached.entries;
    }

    const entries = await listVersions(sourcePath);
    cache.set(sourcePath, { entries, loadedAt: Date.now() });
    return entries;
}

/**
 * Invalidate the cache for a specific note, or all notes if no path given.
 */
export function invalidateVersionCache(sourcePath?: string): void {
    if (sourcePath) {
        cache.delete(sourcePath);
    } else {
        cache.clear();
    }
}

/**
 * Get cache statistics for monitoring.
 */
export function getVersionCacheStats(): { cachedNotes: number; totalEntries: number } {
    let totalEntries = 0;
    for (const { entries } of cache.values()) {
        totalEntries += entries.length;
    }
    return { cachedNotes: cache.size, totalEntries };
}

/**
 * Get the latest version entry for a note (newest), or null if none.
 */
export async function getLatestVersion(sourcePath: string): Promise<VersionEntry | null> {
    const entries = await getCachedVersions(sourcePath);
    return entries.length > 0 ? entries[0] : null;
}

/**
 * Check if a note has any versions.
 */
export async function hasVersions(sourcePath: string): Promise<boolean> {
    const entries = await getCachedVersions(sourcePath);
    return entries.length > 0;
}

/**
 * Find a version entry by timestamp (exact or prefix match).
 */
export async function findVersionByTimestamp(sourcePath: string, timestamp: string): Promise<VersionEntry | null> {
    const entries = await getCachedVersions(sourcePath);
    return entries.find(
        (e) => e.timestamp === timestamp || e.timestamp.startsWith(timestamp),
    ) ?? null;
}
