/**
 * Configuration resolver for Quill memory intelligence layer.
 * Reads from vault.config.json, environment variables, and defaults.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { MemoryType, Importance } from "./memory-schema.js";

export interface QuillConfig {
    memory: {
        enabled: boolean;
        directories: {
            memories: string;
            sessions: string;
            state: string;
            archive: string;
        };
        typeDirs: Partial<Record<MemoryType, string>>;
    };
    ranking: {
        projectBoost: number;
        projectMissPenalty: number;
        importanceWeights: Record<Importance, number>;
        recencyLambda: number;
        archivedPenalty: number;
        conflictPenalty: number;
        graphBoostFactor: number;
        bm25: { k1: number; b: number };
    };
    consolidation: {
        jaccardThreshold: number;
        staleDays: number;
        lowConfidenceThreshold: number;
        promotionReferenceThreshold: number;
        promotionConfidenceThreshold: number;
    };
    audit: {
        maxFileSizeMb: number;
        rotationEnabled: boolean;
    };
    guide: Record<string, string>;
}

const DEFAULT_CONFIG: QuillConfig = {
    memory: {
        enabled: true,
        directories: {
            memories: "memories",
            sessions: "sessions",
            state: "state",
            archive: "archive",
        },
        typeDirs: {},
    },
    ranking: {
        projectBoost: 2.0,
        projectMissPenalty: 0.1,
        importanceWeights: {
            CRITICAL: 2.0,
            HIGH: 1.5,
            NORMAL: 1.0,
            LOW: 0.5,
            EPHEMERAL: 0.1,
        },
        recencyLambda: 0.01,
        archivedPenalty: 0.5,
        conflictPenalty: 0.3,
        graphBoostFactor: 0.2,
        bm25: { k1: 1.2, b: 0.75 },
    },
    consolidation: {
        jaccardThreshold: 0.7,
        staleDays: 30,
        lowConfidenceThreshold: 0.3,
        promotionReferenceThreshold: 3,
        promotionConfidenceThreshold: 0.9,
    },
    audit: {
        maxFileSizeMb: 10,
        rotationEnabled: true,
    },
    guide: {},
};

let cachedConfig: QuillConfig | undefined;

/**
 * Get the project root directory.
 */
function getProjectRoot(): string {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    return resolve(currentDir, "..", "..");
}

/**
 * Resolve configuration from vault.config.json → env → defaults.
 */
export function resolveConfig(): QuillConfig {
    if (cachedConfig) return cachedConfig;

    const configPath = resolve(getProjectRoot(), "vault.config.json");
    let fileConfig: Record<string, unknown> = {};

    try {
        const content = readFileSync(configPath, "utf-8");
        fileConfig = JSON.parse(content);
    } catch {
        // Config file doesn't exist or is invalid — use defaults
    }

    // Deep merge file config over defaults
    const config = deepMerge(
        DEFAULT_CONFIG as unknown as Record<string, unknown>,
        fileConfig,
    ) as unknown as QuillConfig;

    // Environment variable overrides
    if (process.env.QUILL_MEMORY_DISABLED === "true") {
        config.memory.enabled = false;
    }
    if (process.env.QUILL_MEMORIES_DIR) {
        config.memory.directories.memories = process.env.QUILL_MEMORIES_DIR;
    }
    if (process.env.QUILL_RECENT_LAMBDA) {
        config.ranking.recencyLambda = parseFloat(process.env.QUILL_RECENT_LAMBDA);
    }

    cachedConfig = config;
    return config;
}

/**
 * Get the resolved configuration (calls resolveConfig on first access).
 */
export function getConfig(): QuillConfig {
    return resolveConfig();
}

/**
 * Reset cached config (for testing).
 */
export function resetConfig(): void {
    cachedConfig = undefined;
}

/**
 * Deep merge source over target, returning a new object.
 */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
    const result = { ...target };

    for (const [key, value] of Object.entries(source)) {
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
            const targetValue = target[key];
            if (targetValue !== null && typeof targetValue === "object" && !Array.isArray(targetValue)) {
                result[key] = deepMerge(targetValue as Record<string, unknown>, value as Record<string, unknown>);
            } else {
                result[key] = value;
            }
        } else if (value !== undefined) {
            result[key] = value;
        }
    }

    return result;
}
