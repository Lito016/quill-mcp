#!/usr/bin/env node
/**
 * Copies templates/ into dist/templates/ when the source directory exists.
 *
 * generate-hive-canvas resolves its TSX template relative to the compiled
 * output (dist/tools → ../templates), so the canvas TSX side-output requires
 * dist/templates/hive-canvas-footer.tsx to exist after a build.
 *
 * A missing templates/ directory is not an error: the canvas tool skips TSX
 * generation gracefully when the template is absent.
 */
import { existsSync, cpSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "templates");
const dest = join(root, "dist", "templates");

if (!existsSync(src)) {
    console.log("copy-templates: no templates/ directory — skipping (canvas TSX side-output disabled)");
    process.exit(0);
}

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log("copy-templates: copied templates/ -> dist/templates");
