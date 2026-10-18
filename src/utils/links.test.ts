/**
 * Unit tests for link extraction utilities.
 * Covers wikilinks, embeds, heading/block references, markdown links, and the flat target list.
 */
import { describe, it, expect } from "vitest";
import { extractLinks, extractLinkTargets } from "./links.js";

describe("extractLinks", () => {
    it("extracts simple wikilinks", () => {
        const { wiki } = extractLinks("See [[other-note]] for details");
        expect(wiki).toHaveLength(1);
        expect(wiki[0].target).toBe("other-note");
        expect(wiki[0].isEmbed).toBe(false);
    });

    it("extracts wikilinks with display text", () => {
        const { wiki } = extractLinks("Read [[architecture|the architecture doc]]");
        expect(wiki[0].target).toBe("architecture");
        expect(wiki[0].displayText).toBe("the architecture doc");
    });

    it("extracts wikilinks with heading references", () => {
        const { wiki } = extractLinks("See [[setup#Installation]]");
        expect(wiki[0].target).toBe("setup");
        expect(wiki[0].heading).toBe("Installation");
    });

    it("extracts wikilinks with block ID references", () => {
        const { wiki } = extractLinks("Reference [[notes#^block-42]]");
        expect(wiki[0].target).toBe("notes");
        expect(wiki[0].blockId).toBe("block-42");
    });

    it("extracts embed wikilinks (![[...]])", () => {
        const { wiki } = extractLinks("Embedded: ![[image-note]]");
        expect(wiki).toHaveLength(1);
        expect(wiki[0].target).toBe("image-note");
        expect(wiki[0].isEmbed).toBe(true);
    });

    it("does not double-count embeds as regular wikilinks", () => {
        const { wiki } = extractLinks("![[embed]] and [[regular]]");
        expect(wiki).toHaveLength(2);
        expect(wiki.filter((w) => w.isEmbed)).toHaveLength(1);
        expect(wiki.filter((w) => !w.isEmbed)).toHaveLength(1);
    });

    it("extracts markdown links to .md files", () => {
        const { markdown } = extractLinks("See [the guide](guide.md) for more");
        expect(markdown).toHaveLength(1);
        expect(markdown[0].text).toBe("the guide");
        expect(markdown[0].target).toBe("guide.md");
        expect(markdown[0].isEmbed).toBe(false);
    });

    it("extracts markdown links with heading anchors", () => {
        const { markdown } = extractLinks("[section](doc.md#heading)");
        expect(markdown[0].target).toBe("doc.md#heading");
    });

    it("extracts markdown image embeds", () => {
        const { markdown } = extractLinks("![alt text](photo.png)");
        expect(markdown).toHaveLength(1);
        expect(markdown[0].text).toBe("alt text");
        expect(markdown[0].target).toBe("photo.png");
        expect(markdown[0].isEmbed).toBe(true);
    });

    it("ignores markdown links to external URLs", () => {
        const { markdown } = extractLinks("[Google](https://google.com)");
        // Only .md links are captured as non-embed markdown links
        const mdLinks = markdown.filter((m) => !m.isEmbed);
        expect(mdLinks).toHaveLength(0);
    });

    it("extracts multiple links from mixed content", () => {
        const content = `
# My Note
See [[project-a]] and [[project-b|Project B]] for context.
Also check [setup guide](setup.md) and ![[diagram]].
External: [docs](https://docs.example.com)
`;
        const { wiki, allTargets } = extractLinks(content);
        expect(wiki).toHaveLength(3); // project-a, project-b, diagram
        expect(allTargets).toContain("project-a");
        expect(allTargets).toContain("project-b");
        expect(allTargets).toContain("diagram");
        expect(allTargets).toContain("setup.md");
    });

    it("returns empty results for content with no links", () => {
        const { wiki, markdown, allTargets } = extractLinks("Just plain text, nothing special.");
        expect(wiki).toHaveLength(0);
        expect(markdown).toHaveLength(0);
        expect(allTargets).toHaveLength(0);
    });

    it("skips wikilinks with empty targets", () => {
        const { wiki } = extractLinks("Empty [[]] link");
        expect(wiki).toHaveLength(0);
    });
});

describe("extractLinkTargets", () => {
    it("returns a flat list of all link targets", () => {
        const targets = extractLinkTargets("[[a]] and [[b]] and [c](c.md)");
        expect(targets).toContain("a");
        expect(targets).toContain("b");
        expect(targets).toContain("c.md");
    });

    it("returns empty array for no links", () => {
        expect(extractLinkTargets("no links here")).toHaveLength(0);
    });
});
