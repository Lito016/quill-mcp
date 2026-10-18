/**
 * Unit tests for frontmatter parsing, tag extraction, and stringification.
 * Covers nested objects, inline objects, multi-line arrays, type coercion, and edge cases.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { parseFrontmatter, extractTags, stringifyFrontmatter, parseFrontmatterPartial } from "./frontmatter.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

describe("parseFrontmatter", () => {
    it("returns empty frontmatter for content without delimiters", () => {
        const { frontmatter, content } = parseFrontmatter("Just plain text");
        expect(frontmatter).toEqual({});
        expect(content).toBe("Just plain text");
    });

    it("parses simple key-value pairs", () => {
        const input = "---\ntitle: My Note\ntags: [a, b]\n---\nBody text";
        const { frontmatter, content } = parseFrontmatter(input);
        expect(frontmatter.title).toBe("My Note");
        expect(frontmatter.tags).toEqual(["a", "b"]);
        expect(content).toBe("Body text");
    });

    it("parses boolean values", () => {
        const input = "---\npublished: true\ndraft: false\n---\n";
        const { frontmatter } = parseFrontmatter(input);
        expect(frontmatter.published).toBe(true);
        expect(frontmatter.draft).toBe(false);
    });

    it("parses integer values", () => {
        const input = "---\ncount: 42\nnegative: -5\n---\n";
        const { frontmatter } = parseFrontmatter(input);
        expect(frontmatter.count).toBe(42);
        expect(frontmatter.negative).toBe(-5);
    });

    it("parses float values", () => {
        const input = "---\nprice: 9.99\n---\n";
        const { frontmatter } = parseFrontmatter(input);
        expect(frontmatter.price).toBeCloseTo(9.99);
    });

    it("parses null and empty values", () => {
        const input = "---\nnothing: null\nempty:\n---\n";
        const { frontmatter } = parseFrontmatter(input);
        expect(frontmatter.nothing).toBeNull();
        // Empty values (key:) parse as undefined, not null
        expect(frontmatter.empty).toBeUndefined();
    });

    it("parses inline arrays", () => {
        const input = "---\ntags: [typescript, mcp, vault]\n---\n";
        const { frontmatter } = parseFrontmatter(input);
        expect(frontmatter.tags).toEqual(["typescript", "mcp", "vault"]);
    });

    it("parses empty inline arrays", () => {
        const input = "---\ntags: []\n---\n";
        const { frontmatter } = parseFrontmatter(input);
        expect(frontmatter.tags).toEqual([]);
    });

    it("parses multi-line arrays", () => {
        const input = "---\ntags:\n  - typescript\n  - mcp\n  - vault\n---\n";
        const { frontmatter } = parseFrontmatter(input);
        expect(frontmatter.tags).toEqual(["typescript", "mcp", "vault"]);
    });

    it("parses nested objects", () => {
        const input = "---\nsource:\n  type: AGENT\n  reference: conversation\n---\n";
        const { frontmatter } = parseFrontmatter(input);
        expect(frontmatter.source).toEqual({ type: "AGENT", reference: "conversation" });
    });

    it("parses inline objects", () => {
        const input = "---\nmeta: {key: value, count: 5}\n---\n";
        const { frontmatter } = parseFrontmatter(input);
        const meta = frontmatter.meta as Record<string, unknown>;
        expect(meta.key).toBe("value");
        expect(meta.count).toBe(5);
    });

    it("strips surrounding quotes from string values", () => {
        const input = '---\ntitle: "Quoted Title"\nalias: \'single\'\n---\n';
        const { frontmatter } = parseFrontmatter(input);
        expect(frontmatter.title).toBe("Quoted Title");
        expect(frontmatter.alias).toBe("single");
    });

    it("handles content with no body after frontmatter", () => {
        const input = "---\ntitle: Empty\n---\n";
        const { frontmatter, content } = parseFrontmatter(input);
        expect(frontmatter.title).toBe("Empty");
        expect(content).toBe("");
    });
});

describe("extractTags", () => {
    it("extracts hashtags from content", () => {
        const tags = extractTags("Some text #typescript and #mcp here");
        expect(tags).toContain("typescript");
        expect(tags).toContain("mcp");
    });

    it("extracts tags with slashes (subtags)", () => {
        const tags = extractTags("See #project/alpha for details");
        expect(tags).toContain("project/alpha");
    });

    it("extracts tags at the start of a line", () => {
        const tags = extractTags("#first tag at start");
        expect(tags).toContain("first");
    });

    it("deduplicates repeated tags", () => {
        const tags = extractTags("#dup text #dup again");
        expect(tags).toHaveLength(1);
    });

    it("returns empty array for content without tags", () => {
        expect(extractTags("no tags here")).toHaveLength(0);
    });

    it("does not match hash inside words", () => {
        const tags = extractTags("C# programming");
        // "C#" is not a tag because # is not preceded by whitespace or start
        expect(tags).not.toContain("C#");
    });
});

describe("stringifyFrontmatter", () => {
    it("wraps output in --- delimiters", () => {
        const result = stringifyFrontmatter({ title: "Test" });
        expect(result.startsWith("---\n")).toBe(true);
        expect(result.endsWith("---\n")).toBe(true);
    });

    it("stringifies simple key-value pairs", () => {
        const result = stringifyFrontmatter({ title: "My Note", count: 42 });
        expect(result).toContain("title: My Note");
        expect(result).toContain("count: 42");
    });

    it("stringifies short arrays inline", () => {
        const result = stringifyFrontmatter({ tags: ["a", "b"] });
        expect(result).toContain("tags: [a, b]");
    });

    it("stringifies long arrays as multi-line", () => {
        const result = stringifyFrontmatter({ tags: ["a", "b", "c", "d"] });
        expect(result).toContain("tags:");
        expect(result).toContain("  - a");
        expect(result).toContain("  - d");
    });

    it("stringifies empty arrays", () => {
        const result = stringifyFrontmatter({ tags: [] });
        expect(result).toContain("tags: []");
    });

    it("stringifies nested objects", () => {
        const result = stringifyFrontmatter({ source: { type: "AGENT" } });
        expect(result).toContain("source:");
        expect(result).toContain("  type: AGENT");
    });

    it("stringifies null values", () => {
        const result = stringifyFrontmatter({ nothing: null });
        expect(result).toContain("nothing: null");
    });

    it("stringifies boolean values", () => {
        const result = stringifyFrontmatter({ published: true });
        expect(result).toContain("published: true");
    });
});

// ─── parseFrontmatterPartial boundary tests ──────────────────────────

const TMP_DIR = resolve(process.cwd(), ".test-fm-partial");

beforeAll(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
    mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
});

function writeTmp(name: string, content: string): string {
    const p = join(TMP_DIR, name);
    writeFileSync(p, content, "utf-8");
    return p;
}

describe("parseFrontmatterPartial", () => {
    it("matches full parser for small frontmatter", async () => {
        const content = "---\ntitle: Hello\ntags: [a, b]\n---\nBody text here";
        const path = writeTmp("small.md", content);
        const partial = await parseFrontmatterPartial(path);
        const full = parseFrontmatter(content);
        expect(partial.frontmatter).toEqual(full.frontmatter);
    });

    it("returns empty frontmatter for file without delimiters", async () => {
        const path = writeTmp("no-fm.md", "Just plain text\nNo frontmatter here");
        const result = await parseFrontmatterPartial(path);
        expect(result.frontmatter).toEqual({});
    });

    it("falls back to full read when closing delimiter exceeds buffer", async () => {
        // Build frontmatter that's larger than a tiny buffer
        const bigValue = "x".repeat(200);
        const lines: string[] = ["---"];
        for (let i = 0; i < 50; i++) {
            lines.push(`key${i}: ${bigValue}`);
        }
        lines.push("---");
        lines.push("Body content");
        const content = lines.join("\n");
        const path = writeTmp("big-fm.md", content);

        // Use a tiny buffer to force fallback
        const partial = await parseFrontmatterPartial(path, 256);
        const full = parseFrontmatter(content);
        expect(partial.frontmatter).toEqual(full.frontmatter);
    });

    it("handles frontmatter ending exactly at buffer boundary", async () => {
        // Build content where closing \n--- lands right at byte 4096
        const header = "---\n";
        const footer = "\n---\nBody";
        const paddingNeeded = 4096 - header.length - footer.length;
        const body = "title: " + "A".repeat(paddingNeeded - 8); // "title: " = 7 chars
        const content = header + body + footer;
        const path = writeTmp("exact-boundary.md", content);

        const partial = await parseFrontmatterPartial(path, 4096);
        const full = parseFrontmatter(content);
        expect(partial.frontmatter).toEqual(full.frontmatter);
    });

    it("does not match bare --- in content as closing delimiter", async () => {
        // The content has "---" on a line but NOT preceded by \n at the start
        // This should NOT be treated as the closing delimiter
        const content = "---\ntitle: Test\nnote: see --- for details\n---\nBody";
        const path = writeTmp("bare-dashes.md", content);

        const partial = await parseFrontmatterPartial(path);
        const full = parseFrontmatter(content);
        expect(partial.frontmatter).toEqual(full.frontmatter);
        expect(partial.frontmatter.title).toBe("Test");
    });

    it("handles CRLF line endings", async () => {
        const content = "---\r\ntitle: CRLF Test\r\ntags: [x]\r\n---\r\nBody with CRLF";
        const path = writeTmp("crlf.md", content);

        const partial = await parseFrontmatterPartial(path);
        const full = parseFrontmatter(content);
        expect(partial.frontmatter).toEqual(full.frontmatter);
        expect(partial.frontmatter.title).toBe("CRLF Test");
    });

    it("handles file with only opening delimiter (no closing)", async () => {
        const content = "---\ntitle: Incomplete\nno closing delimiter";
        const path = writeTmp("no-close.md", content);

        const partial = await parseFrontmatterPartial(path);
        const full = parseFrontmatter(content);
        expect(partial.frontmatter).toEqual(full.frontmatter);
    });

    it("handles UTF-8 multi-byte characters in frontmatter", async () => {
        const content = "---\ntitle: \u{1F600} Emoji Title\ndesc: \u00e9\u00e8\u00ea accented\n---\nBody";
        const path = writeTmp("utf8.md", content);

        const partial = await parseFrontmatterPartial(path);
        const full = parseFrontmatter(content);
        expect(partial.frontmatter).toEqual(full.frontmatter);
    });

    it("produces identical results to full parser across varied inputs", async () => {
        const cases = [
            "---\ntitle: Simple\n---\n",
            "---\ntags:\n  - alpha\n  - beta\n---\nBody",
            "---\nobj: {a: 1, b: 2}\n---\n",
            "---\nempty_val:\n---\n",
            "---\nbool: true\nnum: 42\nfloat: 3.14\n---\n",
        ];
        for (const content of cases) {
            const path = writeTmp(`equiv-${cases.indexOf(content)}.md`, content);
            const partial = await parseFrontmatterPartial(path);
            const full = parseFrontmatter(content);
            expect(partial.frontmatter).toEqual(full.frontmatter);
        }
    });

    // ─── Property-based tests ─────────────────────────────────────────────
    // Generate random frontmatter and verify partial == full parser

    it("property: random ASCII frontmatter produces identical results", async () => {
        for (let trial = 0; trial < 50; trial++) {
            const keys = Array.from({ length: 3 + Math.floor(Math.random() * 5) }, (_, i) => `key${i}`);
            const lines = ["---"];
            for (const key of keys) {
                const valueLen = 5 + Math.floor(Math.random() * 50);
                const value = Array.from({ length: valueLen }, () =>
                    String.fromCharCode(32 + Math.floor(Math.random() * 95)),
                ).join("");
                lines.push(`${key}: ${value}`);
            }
            lines.push("---");
            lines.push("Body content here");
            const content = lines.join("\n");
            const path = writeTmp(`prop-ascii-${trial}.md`, content);

            const partial = await parseFrontmatterPartial(path);
            const full = parseFrontmatter(content);
            expect(partial.frontmatter).toEqual(full.frontmatter);
        }
    });

    it("property: random Unicode frontmatter produces identical results", async () => {
        const unicodeChars = [
            "\u{1F600}", "\u{1F680}", "\u{1F389}", // Emoji
            "\u00e9", "\u00e8", "\u00ea", "\u00fc", // Accented
            "\u4e16", "\u754c", "\u{4F60}", "\u{597D}", // CJK
            "\u0410", "\u0411", "\u0412", // Cyrillic
            "\u0391", "\u0392", "\u0393", // Greek
            "\u2603", "\u2764", "\u2605", // Symbols
        ];

        for (let trial = 0; trial < 30; trial++) {
            const keys = Array.from({ length: 2 + Math.floor(Math.random() * 4) }, (_, i) => `key${i}`);
            const lines = ["---"];
            for (const key of keys) {
                const valueLen = 3 + Math.floor(Math.random() * 15);
                const value = Array.from({ length: valueLen }, () =>
                    unicodeChars[Math.floor(Math.random() * unicodeChars.length)],
                ).join("");
                lines.push(`${key}: ${value}`);
            }
            lines.push("---");
            lines.push("Body");
            const content = lines.join("\n");
            const path = writeTmp(`prop-unicode-${trial}.md`, content);

            const partial = await parseFrontmatterPartial(path);
            const full = parseFrontmatter(content);
            expect(partial.frontmatter).toEqual(full.frontmatter);
        }
    });

    it("property: CRLF line endings produce identical results", async () => {
        for (let trial = 0; trial < 20; trial++) {
            const keys = Array.from({ length: 2 + Math.floor(Math.random() * 4) }, (_, i) => `key${i}`);
            const lines = ["---"];
            for (const key of keys) {
                const value = `value${trial}-${key}`;
                lines.push(`${key}: ${value}`);
            }
            lines.push("---");
            lines.push("Body");
            const content = lines.join("\r\n");
            const path = writeTmp(`prop-crlf-${trial}.md`, content);

            const partial = await parseFrontmatterPartial(path);
            const full = parseFrontmatter(content);
            expect(partial.frontmatter).toEqual(full.frontmatter);
        }
    });

    it("property: delimiter-like text in values does not confuse parser", async () => {
        const trickyValues = [
            "see --- for details",
            "---not-a-delimiter",
            "text\n---\nmore text",
            "--- ",
            " ---",
            "---\t",
            "value --- value --- value",
        ];

        for (let trial = 0; trial < trickyValues.length; trial++) {
            const content = `---\ntitle: ${trickyValues[trial]}\n---\nBody`;
            const path = writeTmp(`prop-delim-${trial}.md`, content);

            const partial = await parseFrontmatterPartial(path);
            const full = parseFrontmatter(content);
            expect(partial.frontmatter).toEqual(full.frontmatter);
        }
    });

    it("property: varying frontmatter sizes produce identical results", async () => {
        const sizes = [100, 500, 1000, 2000, 4000, 4095, 4096, 4097, 8000];
        for (const targetSize of sizes) {
            const lines = ["---"];
            let currentSize = 4; // "---\n"
            let keyIdx = 0;
            while (currentSize < targetSize - 10) {
                const remaining = targetSize - currentSize - 5; // account for "---\n" footer
                const valueLen = Math.min(remaining - 10, 50 + Math.floor(Math.random() * 100));
                if (valueLen <= 0) break;
                const value = "x".repeat(valueLen);
                const line = `k${keyIdx}: ${value}\n`;
                lines.push(`k${keyIdx}: ${value}`);
                currentSize += line.length;
                keyIdx++;
            }
            lines.push("---");
            lines.push("Body");
            const content = lines.join("\n");
            const path = writeTmp(`prop-size-${targetSize}.md`, content);

            const partial = await parseFrontmatterPartial(path);
            const full = parseFrontmatter(content);
            expect(partial.frontmatter).toEqual(full.frontmatter);
        }
    });
});
