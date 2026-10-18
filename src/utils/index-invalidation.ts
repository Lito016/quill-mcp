/**
 * Central vault-change notification for the in-memory search indexes.
 *
 * Two granularities:
 *  - markVaultChanged(): unknown/external change (watcher poll, bulk regen).
 *    The next search performs a full vault rescan.
 *  - invalidateVaultPath(relPath): a server-side mutation of one known path
 *    (write, delete, move, folder rename). The next search re-checks exactly
 *    that path instead of walking the whole vault.
 *
 * All mutating user tools route their write/delete destinations through
 * safeWriteTarget/safeDeleteTarget in utils/vault.ts, which call
 * invalidateVaultPath — one hook covers every mutation path.
 *
 * Note: this module is imported by utils/vault.ts while the index modules
 * themselves import utils/vault.ts. That ESM cycle is benign: index singletons
 * never call vault functions during module evaluation, only at request time.
 */

import { knowledgeIndex } from "./knowledge-index.js";
import { searchIndex } from "./search-index.js";

/** External or bulk change: next search does a full rescan (dirty flag). */
export function markVaultChanged(): void {
    knowledgeIndex.markDirty();
    searchIndex.markDirty();
}

/**
 * Server-side mutation of one vault-relative path: schedule a precise
 * re-check on the next index synchronization. Paths are normalised to
 * forward slashes without leading/trailing slashes; traversal segments
 * and empty paths are ignored defensively.
 */
export function invalidateVaultPath(relativePath: string): void {
    const rel = relativePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!rel || rel.split("/").includes("..")) return;
    knowledgeIndex.invalidatePath(rel);
    searchIndex.invalidatePath(rel);
}
