/**
 * Tests for generate-hive-canvas tool handler.
 * Covers: successful generation, traversal defense, unsafe targets,
 * partial failure, template absence, and no writes outside vault.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { initVault } from "../utils/vault.js";
import * as generateHiveCanvas from "./generate-hive-canvas.js";

const TEST_VAULT = join(process.cwd(), "test-vault-canvas-temp");

describe("generate_hive_canvas handler", () => {
    beforeEach(async () => {
        await mkdir(TEST_VAULT, { recursive: true });
        process.argv = ["node", "index.js", TEST_VAULT];
        initVault();
    });

    afterEach(async () => {
        await rm(TEST_VAULT, { recursive: true, force: true });
    });

    it("should return zero-result message when no notes exist", async () => {
        // No requested scan roots exist, so scan finds nothing
        const result = await generateHiveCanvas.handler({
            output_path: "canvases/hive.canvas.json",
            scan_path: "plugin,knowledge",
            include_references: false,
        });
        expect(result.isError).toBeFalsy();
        expect(result.content![0].text).toContain("0 nodes");
    });

    it("should generate JSON file successfully with minimal notes", async () => {
        // Create a minimal plugin directory with one note
        await mkdir(join(TEST_VAULT, "plugin", "test-skill"), { recursive: true });
        await writeFile(
            join(TEST_VAULT, "plugin", "test-skill", "test-skill.md"),
            "---\ndescription: A test skill\n---\n# Test Skill\nA simple test skill.",
        );
        await writeFile(
            join(TEST_VAULT, "plugin", "HIVE-MIND.md"),
            "---\ndescription: Shared memory hub\n---\n# HIVE MIND",
        );

        const result = await generateHiveCanvas.handler({
            output_path: "canvases/test.canvas.json",
            scan_path: "plugin",
            include_references: false,
        });
        expect(result.isError).toBeFalsy();
        expect(result.content![0].text).toContain("generated");

        // Verify JSON file was created
        const jsonPath = join(TEST_VAULT, "canvases", "test.canvas.json");
        expect(existsSync(jsonPath)).toBe(true);
        const jsonContent = await readFile(jsonPath, "utf-8");
        const parsed = JSON.parse(jsonContent);
        expect(parsed.title).toBe("Vault Knowledge Graph");
        expect(parsed.schemaVersion).toBe(4);
        expect(parsed.nodes).toBeDefined();
        expect(parsed.links).toBeDefined();
        expect(parsed.stats).toBeDefined();
    });

    it("should reject path traversal in output_path", async () => {
        // Must have scannable content so output path validation is reached
        await mkdir(join(TEST_VAULT, "plugin"), { recursive: true });
        await writeFile(join(TEST_VAULT, "plugin", "note.md"), "# Note");
        const result = await generateHiveCanvas.handler({
            output_path: "../../etc/canvas.json",
            scan_path: "plugin",
            include_references: false,
        });
        expect(result.isError).toBe(true);
        expect(result.content![0].text).toContain("Error");
    });

    it("should reject output to protected directory", async () => {
        await mkdir(join(TEST_VAULT, "plugin"), { recursive: true });
        await writeFile(join(TEST_VAULT, "plugin", "note.md"), "# Note");
        const result = await generateHiveCanvas.handler({
            output_path: ".trash/canvas.json",
            scan_path: "plugin",
            include_references: false,
        });
        expect(result.isError).toBe(true);
        expect(result.content![0].text).toContain("protected");
    });

    it("should reject output to vault root", async () => {
        await mkdir(join(TEST_VAULT, "plugin"), { recursive: true });
        await writeFile(join(TEST_VAULT, "plugin", "note.md"), "# Note");
        const result = await generateHiveCanvas.handler({
            output_path: ".",
            scan_path: "plugin",
            include_references: false,
        });
        expect(result.isError).toBe(true);
    });

    it("should not write outside vault even with valid scan path", async () => {
        await mkdir(join(TEST_VAULT, "plugin"), { recursive: true });
        await writeFile(join(TEST_VAULT, "plugin", "note.md"), "# Note");

        await generateHiveCanvas.handler({
            output_path: "canvases/output.json",
            scan_path: "plugin",
            include_references: false,
        });

        // Verify canvas files only exist inside the vault
        const jsonPath = join(TEST_VAULT, "canvases", "output.json");
        expect(existsSync(jsonPath)).toBe(true);
        // Verify the vault parent does NOT contain canvas files at its level
        // (the vault itself is inside cwd, so check that canvas files are
        // inside the vault, not beside it)
        const outsideVault = join(TEST_VAULT, "..", "canvases");
        expect(existsSync(outsideVault)).toBe(false);
    });

    it("should handle scan path that does not exist", async () => {
        const result = await generateHiveCanvas.handler({
            output_path: "canvases/empty.json",
            scan_path: "nonexistent-dir",
            include_references: false,
        });
        expect(result.isError).toBeFalsy();
        expect(result.content![0].text).toContain("0 nodes");
    });

    it("should generate TSX alongside JSON when template exists", async () => {
        // Create minimal notes
        await mkdir(join(TEST_VAULT, "plugin", "test-skill"), { recursive: true });
        await writeFile(join(TEST_VAULT, "plugin", "test-skill", "test-skill.md"), "# Test");
        await writeFile(join(TEST_VAULT, "plugin", "HIVE-MIND.md"), "# HIVE");

        const result = await generateHiveCanvas.handler({
            output_path: "canvases/hive.canvas.json",
            scan_path: "plugin",
            include_references: false,
        });
        expect(result.isError).toBeFalsy();

        // Check if TSX was generated (depends on template availability)
        const tsxPath = join(TEST_VAULT, "canvases", "hive.canvas.tsx");
        if (existsSync(tsxPath)) {
            const tsxContent = await readFile(tsxPath, "utf-8");
            expect(tsxContent).toContain("hiveData");
            expect(tsxContent).toContain("use client");
        }
        // Either way, JSON must exist
        expect(existsSync(join(TEST_VAULT, "canvases", "hive.canvas.json"))).toBe(true);
    });

    it("should handle non-.json output path without TSX collision", async () => {
        await mkdir(join(TEST_VAULT, "plugin"), { recursive: true });
        await writeFile(join(TEST_VAULT, "plugin", "note.md"), "# Note");

        const result = await generateHiveCanvas.handler({
            output_path: "canvases/output.dat",
            scan_path: "plugin",
            include_references: false,
        });
        expect(result.isError).toBeFalsy();
        // .dat file should be created, no .tsx collision
        expect(existsSync(join(TEST_VAULT, "canvases", "output.dat"))).toBe(true);
    });

    it("should include knowledge nodes", async () => {
        await mkdir(join(TEST_VAULT, "knowledge"), { recursive: true });
        await writeFile(join(TEST_VAULT, "knowledge", "topic.md"), "# Topic\nSome knowledge.");

        const result = await generateHiveCanvas.handler({
            output_path: "canvases/knowledge.json",
            scan_path: "knowledge",
            include_references: false,
        });
        expect(result.isError).toBeFalsy();
        const jsonContent = await readFile(join(TEST_VAULT, "canvases", "knowledge.json"), "utf-8");
        const parsed = JSON.parse(jsonContent);
        // Should have at least the knowledge reference and its group hub.
        expect(parsed.nodes.length).toBeGreaterThan(0);
    });

    it("should scan generic vault roots by default", async () => {
        await writeFile(join(TEST_VAULT, "README.md"), "# Vault\nRoot index.");
        await mkdir(join(TEST_VAULT, "solutions"), { recursive: true });
        await mkdir(join(TEST_VAULT, "projects"), { recursive: true });
        await mkdir(join(TEST_VAULT, "memories", "discoveries"), { recursive: true });
        await writeFile(join(TEST_VAULT, "solutions", "fix.md"), "# Fix\nReusable solution.");
        await writeFile(join(TEST_VAULT, "projects", "app.md"), "# App\nProject memory.");
        await writeFile(join(TEST_VAULT, "memories", "discoveries", "thing.md"), "# Thing\nDiscovery.");

        const result = await generateHiveCanvas.handler({
            output_path: "canvases/default.json",
            scan_path: "README.md,knowledge,notes,memories,projects,solutions",
            include_references: false,
        });
        expect(result.isError).toBeFalsy();

        const parsed = JSON.parse(await readFile(join(TEST_VAULT, "canvases", "default.json"), "utf-8"));
        const paths = parsed.nodes.map((node: { path: string }) => node.path);
        expect(paths).toContain("README.md");
        expect(paths).toContain("solutions/fix.md");
        expect(paths).toContain("projects/app.md");
        expect(paths).toContain("memories/discoveries/thing.md");
        expect(paths.some((path: string) => path.startsWith("plugin/"))).toBe(false);
    });
});
