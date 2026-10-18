import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { initVault } from "./vault.js";
import { knowledgeIndex, DISCOVERY_FIELDS } from "./knowledge-index.js";

const TEST_VAULT = join(process.cwd(), "test-vault-temp-knowledge-index");
const discoverOne = (query: string) => knowledgeIndex.discover(query, ".", [...DISCOVERY_FIELDS], ["file"]);

describe("KnowledgeIndex incremental sync and precise invalidation", () => {
    beforeEach(async () => {
        await rm(TEST_VAULT, { recursive: true, force: true });
        await mkdir(join(TEST_VAULT, "notes"), { recursive: true });
        await writeFile(join(TEST_VAULT, "notes", "one.md"), "uniquetermone lives here", "utf-8");
        process.env.NOTES_VAULT_PATH = TEST_VAULT;
        delete process.argv[2];
        initVault();
        knowledgeIndex.reset();
        await knowledgeIndex.ensureSynchronized();
    });

    afterEach(async () => {
        knowledgeIndex.reset();
        delete process.env.NOTES_VAULT_PATH;
        await rm(TEST_VAULT, { recursive: true, force: true });
    });

    it("should discover content terms after the initial sync", () => {
        const hits = discoverOne("uniquetermone");
        expect(hits).toHaveLength(1);
        expect(hits[0].path).toBe("notes/one.md");
    });

    it("should make new files discoverable via precise invalidation", async () => {
        await writeFile(join(TEST_VAULT, "notes", "two.md"), "brandnewtoken lives here", "utf-8");
        knowledgeIndex.invalidatePath("notes/two.md");
        await knowledgeIndex.ensureSynchronized();

        expect(discoverOne("brandnewtoken").map((hit) => hit.path)).toContain("notes/two.md");
    });

    it("should drop deleted files from discovery via precise invalidation", async () => {
        await unlink(join(TEST_VAULT, "notes", "one.md"));
        knowledgeIndex.invalidatePath("notes/one.md");
        await knowledgeIndex.ensureSynchronized();

        expect(discoverOne("uniquetermone")).toHaveLength(0);
    });

    it("should re-check only invalidated paths, not run a full vault walk", async () => {
        await writeFile(join(TEST_VAULT, "notes", "ghost.md"), "ghosttoken lives here", "utf-8");
        // Index ghost.md via the precise path (a no-op sync never picks up new files)
        knowledgeIndex.invalidatePath("notes/ghost.md");
        await knowledgeIndex.ensureSynchronized();
        // Delete ghost.md externally WITHOUT any invalidation...
        await unlink(join(TEST_VAULT, "notes", "ghost.md"));
        // ...then mutate a different file precisely
        await writeFile(join(TEST_VAULT, "notes", "one.md"), "uniquetermone updated", "utf-8");
        knowledgeIndex.invalidatePath("notes/one.md");
        await knowledgeIndex.ensureSynchronized();

        // The precise path is updated...
        expect(discoverOne("updated").map((hit) => hit.path)).toContain("notes/one.md");
        // ...while the un-invalidated deletion is NOT pruned (full walks do that)
        expect(discoverOne("ghosttoken").map((hit) => hit.path)).toContain("notes/ghost.md");
    });

    it("should suggest the closest indexed term for typo queries", () => {
        expect(knowledgeIndex.suggestCorrection("uniquetermne")).toBe("uniquetermone");
        expect(knowledgeIndex.suggestCorrection("zzzzzzzzzzzzz")).toBeUndefined();
    });
});
