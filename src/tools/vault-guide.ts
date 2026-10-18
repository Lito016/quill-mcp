import * as z from "zod";
import { getConfig } from "../utils/config.js";
import { getVaultRoot } from "../utils/vault.js";
import { readdir } from "node:fs/promises";

export const name = "vault_guide";
export const description =
    "Get the vault folder guide — shows where different types of knowledge are stored. Use this to understand vault structure before creating or searching for notes.";
export const inputSchema = z.object({
    include_undocumented: z.boolean().default(false).describe("Include folders that exist but aren't in the guide"),
});

export async function handler({ include_undocumented = false }: { include_undocumented?: boolean }) {
    const config = getConfig();
    const guide = config.guide || {};
    const vaultPath = getVaultRoot();

    const result: Record<string, unknown> = {
        guide,
        vault_path: vaultPath,
    };

    // Optionally scan for undocumented folders
    if (include_undocumented) {
        try {
            const entries = await readdir(vaultPath, { withFileTypes: true });
            const documentedFolders = new Set(Object.keys(guide));
            const undocumented: string[] = [];

            for (const entry of entries) {
                if (entry.isDirectory() && !entry.name.startsWith(".")) {
                    if (!documentedFolders.has(entry.name)) {
                        undocumented.push(entry.name);
                    }
                }
            }

            result.undocumented_folders = undocumented;
        } catch {
            // Skip if scan fails
        }
    }

    return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
}
