/**
 * Parse only the frontmatter from a file without reading the entire body.
 * Reads at most `maxBytes` (default 4096) from the start of the file,
 * which is sufficient for virtually all frontmatter blocks.
 *
 * Correctness guarantees:
 * - Searches for `\n---` (not bare `---`) to match the full parser's regex.
 * - If the closing delimiter is not found, falls back to reading the full file.
 * - If the buffer cuts mid-UTF8-sequence, falls back to the full file.
 * - Never returns incomplete or divergent metadata.
 */
export async function parseFrontmatterPartial(
    filePath: string,
    maxBytes = 4096,
): Promise<{ frontmatter: Record<string, unknown> }> {
    const { open, readFile } = await import("node:fs/promises");
    let fh;
    try {
        fh = await open(filePath, "r");
        const { size } = await fh.stat();
        const toRead = Math.min(maxBytes, size);
        const buf = Buffer.alloc(toRead);
        await fh.read(buf, 0, toRead, 0);

        // UTF-8 boundary guard: if the buffer ends mid-character, the decoded
        // string will have a replacement char (U+FFFD) at the tail. In that
        // case the closing delimiter might be just past the buffer — fall back.
        const partial = buf.toString("utf-8");
        if (partial.charCodeAt(partial.length - 1) === 0xfffe) {
            // Incomplete multi-byte sequence at buffer boundary — full read
            const full = await readFile(filePath, "utf-8");
            const { frontmatter } = parseFrontmatter(full);
            return { frontmatter };
        }

        // Find opening delimiter
        const firstDelim = partial.indexOf("---");
        if (firstDelim === -1) return { frontmatter: {} };

        // Search for closing delimiter: must be preceded by a newline to match
        // the full parser's regex `\n---`. Searching for bare `---` would
        // produce false positives on `---` embedded in content lines.
        const searchFrom = firstDelim + 3;
        const closingIdx = partial.indexOf("\n---", searchFrom);
        if (closingIdx === -1) {
            // Closing delimiter not in buffer — fall back to full file
            const full = await readFile(filePath, "utf-8");
            const { frontmatter } = parseFrontmatter(full);
            return { frontmatter };
        }

        // We have both delimiters — parse just the frontmatter portion
        const fmContent = partial.slice(0, closingIdx + 1 + 3); // include \n---
        const { frontmatter } = parseFrontmatter(fmContent + "\n");
        return { frontmatter };
    } finally {
        await fh?.close();
    }
}

/**
 * Parse YAML frontmatter from markdown content.
 * Supports nested objects (one level), inline objects, arrays, and multi-line arrays.
 * Returns the frontmatter object and the content without frontmatter.
 */
export function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; content: string } {
    const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;
    const match = content.match(frontmatterRegex);

    if (!match) {
        return { frontmatter: {}, content };
    }

    const frontmatterStr = match[1];
    const remainingContent = match[2];

    const frontmatter: Record<string, unknown> = {};
    const lines = frontmatterStr.split("\n");

    let currentKey = "";
    let currentNested: Record<string, unknown> | null = null;
    let currentArray: string[] | null = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Skip empty lines
        if (!trimmed) continue;

        // Check if this is a nested/indented line (starts with spaces)
        const isIndented = line.startsWith("  ") || line.startsWith("\t");

        // Multi-line array item: "  - value"
        if (isIndented && trimmed.startsWith("- ") && currentKey) {
            if (!currentArray) {
                currentArray = [];
            }
            currentArray.push(parseValue(trimmed.slice(2).trim()) as string);
            continue;
        }

        // Nested object property: "  key: value"
        if (isIndented && currentKey && !trimmed.startsWith("- ")) {
            const nestedColon = trimmed.indexOf(":");
            if (nestedColon !== -1) {
                if (!currentNested) {
                    currentNested = {};
                }
                const nestedKey = trimmed.slice(0, nestedColon).trim();
                const nestedValue = trimmed.slice(nestedColon + 1).trim();
                currentNested[nestedKey] = parseValue(nestedValue);
            }
            continue;
        }

        // Flush any pending nested object or array
        if (currentKey) {
            if (currentNested) {
                frontmatter[currentKey] = currentNested;
                currentNested = null;
            } else if (currentArray) {
                frontmatter[currentKey] = currentArray;
                currentArray = null;
            }
        }

        // Top-level key: value
        const colonIndex = trimmed.indexOf(":");
        if (colonIndex === -1) continue;

        currentKey = trimmed.slice(0, colonIndex).trim();
        const value = trimmed.slice(colonIndex + 1).trim();

        if (value) {
            // Inline object: {key: value, key2: value2}
            if (value.startsWith("{") && value.endsWith("}")) {
                frontmatter[currentKey] = parseInlineObject(value);
                currentKey = "";
            } else {
                frontmatter[currentKey] = parseValue(value);
                currentKey = "";
            }
        }
        // else: value is on subsequent indented lines (nested object or array)
    }

    // Flush any remaining pending value
    if (currentKey) {
        if (currentNested) {
            frontmatter[currentKey] = currentNested;
        } else if (currentArray) {
            frontmatter[currentKey] = currentArray;
        }
    }

    return { frontmatter, content: remainingContent };
}

/**
 * Parse a YAML value string into its appropriate type.
 */
function parseValue(value: string): unknown {
    if (value === "true") return true;
    if (value === "false") return false;
    if (value === "null" || value === "") return null;
    if (/^-?\d+$/.test(value)) return parseInt(value, 10);
    if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
    if (value.startsWith("[") && value.endsWith("]")) {
        const inner = value.slice(1, -1).trim();
        if (!inner) return [];
        return inner.split(",").map((item) => parseValue(item.trim()));
    }
    // Strip surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }
    return value;
}

/**
 * Parse an inline YAML object: {key: value, key2: value2}
 */
function parseInlineObject(value: string): Record<string, unknown> {
    const inner = value.slice(1, -1).trim();
    const result: Record<string, unknown> = {};
    if (!inner) return result;

    const pairs = inner.split(",");
    for (const pair of pairs) {
        const colonIdx = pair.indexOf(":");
        if (colonIdx === -1) continue;
        const key = pair.slice(0, colonIdx).trim();
        const val = pair.slice(colonIdx + 1).trim();
        if (key) {
            result[key] = parseValue(val);
        }
    }
    return result;
}

/**
 * Extract tags from markdown content.
 * Finds hashtags in the format #tag or #tag/subtag.
 */
export function extractTags(content: string): string[] {
    const tagRegex = /(?:^|\s)#([a-zA-Z0-9_/-]+)/g;
    const tags: Set<string> = new Set();
    let match;

    while ((match = tagRegex.exec(content)) !== null) {
        tags.add(match[1]);
    }

    return Array.from(tags);
}

/**
 * Stringify frontmatter back to YAML format.
 * Handles nested objects, arrays, and primitive values.
 */
export function stringifyFrontmatter(frontmatter: Record<string, unknown>): string {
    const lines: string[] = [];

    for (const [key, value] of Object.entries(frontmatter)) {
        if (value === null || value === undefined) {
            lines.push(`${key}: null`);
        } else if (Array.isArray(value)) {
            if (value.length === 0) {
                lines.push(`${key}: []`);
            } else if (value.length <= 3 && value.every((v) => typeof v !== "object")) {
                lines.push(`${key}: [${value.join(", ")}]`);
            } else {
                lines.push(`${key}:`);
                for (const item of value) {
                    lines.push(`  - ${item}`);
                }
            }
        } else if (typeof value === "object") {
            lines.push(`${key}:`);
            for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
                lines.push(`  ${nestedKey}: ${nestedValue}`);
            }
        } else if (typeof value === "boolean") {
            lines.push(`${key}: ${value}`);
        } else {
            lines.push(`${key}: ${value}`);
        }
    }

    return `---\n${lines.join("\n")}\n---\n`;
}
