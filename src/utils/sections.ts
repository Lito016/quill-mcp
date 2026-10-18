/**
 * Section navigation utilities for markdown notes.
 * Parses headings and extracts/replaces sections.
 */

export interface HeadingEntry {
    /** Heading level (1-6) */
    level: number;
    /** Heading text (without # prefix) */
    text: string;
    /** 1-based line number where the heading appears */
    line: number;
    /** Full heading line including # prefix */
    raw: string;
}

export interface SectionInfo {
    /** The heading for this section (null for the preamble before any heading) */
    heading: HeadingEntry | null;
    /** 0-based start line index (inclusive) */
    startLine: number;
    /** 0-based end line index (exclusive) */
    endLine: number;
    /** The content of this section (including the heading line) */
    content: string;
}

/**
 * Extract all headings from markdown content.
 */
export function extractHeadings(content: string): HeadingEntry[] {
    const lines = content.split("\n");
    const headings: HeadingEntry[] = [];
    const headingRegex = /^(#{1,6})\s+(.+)$/;

    for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(headingRegex);
        if (match) {
            headings.push({
                level: match[1].length,
                text: match[2].trim(),
                line: i + 1,
                raw: lines[i],
            });
        }
    }

    return headings;
}

/**
 * Split content into sections delimited by headings.
 * Each section includes its heading line and all content until the next heading
 * of the same or higher level (or end of file).
 *
 * If `maxLevel` is specified, only headings at that level or higher (lower number)
 * create section boundaries. E.g., maxLevel=2 means only ## and # create sections.
 */
export function splitSections(content: string, maxLevel: number = 6): SectionInfo[] {
    const lines = content.split("\n");
    const headingRegex = /^(#{1,6})\s+(.+)$/;
    const sections: SectionInfo[] = [];

    let currentHeading: HeadingEntry | null = null;
    let startLine = 0;

    for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(headingRegex);
        if (match && match[1].length <= maxLevel) {
            // Save previous section
            if (currentHeading !== null || i > startLine) {
                const sectionLines = lines.slice(startLine, i);
                sections.push({
                    heading: currentHeading,
                    startLine,
                    endLine: i,
                    content: sectionLines.join("\n"),
                });
            }

            // Start new section
            currentHeading = {
                level: match[1].length,
                text: match[2].trim(),
                line: i + 1,
                raw: lines[i],
            };
            startLine = i;
        }
    }

    // Final section
    if (startLine < lines.length) {
        const sectionLines = lines.slice(startLine);
        sections.push({
            heading: currentHeading,
            startLine,
            endLine: lines.length,
            content: sectionLines.join("\n"),
        });
    }

    return sections;
}

/**
 * Find a section by heading text (case-insensitive partial match).
 * Returns the section or null if not found.
 */
export function findSectionByHeading(content: string, heading: string, maxLevel: number = 6): SectionInfo | null {
    const sections = splitSections(content, maxLevel);
    const normalizedTarget = heading.toLowerCase();

    for (const section of sections) {
        if (section.heading && section.heading.text.toLowerCase().includes(normalizedTarget)) {
            return section;
        }
    }

    return null;
}

/**
 * Replace the content of a section identified by heading text.
 * Preserves the heading line and replaces everything after it until the next section.
 * Returns the new full content, or null if the heading was not found.
 */
export function replaceSectionByHeading(
    content: string,
    heading: string,
    newBody: string,
    maxLevel: number = 6,
): string | null {
    const sections = splitSections(content, maxLevel);
    const normalizedTarget = heading.toLowerCase();

    for (let i = 0; i < sections.length; i++) {
        const section = sections[i];
        if (section.heading && section.heading.text.toLowerCase().includes(normalizedTarget)) {
            // Rebuild: everything before this section + heading + new body + everything after
            const before = sections.slice(0, i).map((s) => s.content).join("\n");
            const after = sections.slice(i + 1).map((s) => s.content).join("\n");

            const parts: string[] = [];
            if (before) parts.push(before);
            parts.push(section.heading.raw);
            if (newBody) parts.push(newBody);
            if (after) parts.push(after);

            return parts.join("\n");
        }
    }

    return null;
}
