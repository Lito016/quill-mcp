/**
 * Unit tests for the structured JSON logger.
 * Covers log level filtering, message formatting, and metadata serialization.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We need to test the Logger class, but it's not exported — only the singleton is.
// Import the module fresh for each test by testing through the singleton with setLevel.
import { logger } from "./logger.js";

describe("Logger", () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        consoleSpy.mockRestore();
        logger.setLevel("info"); // Reset to default
    });

    it("logs info messages at info level", () => {
        logger.setLevel("info");
        logger.info("test message");
        expect(consoleSpy).toHaveBeenCalledTimes(1);
        expect(consoleSpy.mock.calls[0][0]).toContain("[INFO]");
        expect(consoleSpy.mock.calls[0][0]).toContain("test message");
    });

    it("includes ISO timestamp in log output", () => {
        logger.setLevel("info");
        logger.info("timestamped");
        const output = consoleSpy.mock.calls[0][0] as string;
        // ISO timestamp pattern: [2026-...]
        expect(output).toMatch(/\[\d{4}-\d{2}-\d{2}T/);
    });

    it("includes metadata as JSON when provided", () => {
        logger.setLevel("info");
        logger.info("with meta", { key: "value", count: 42 });
        const output = consoleSpy.mock.calls[0][0] as string;
        expect(output).toContain('{"key":"value","count":42}');
    });

    it("omits metadata section when no meta provided", () => {
        logger.setLevel("info");
        logger.info("no meta");
        const output = consoleSpy.mock.calls[0][0] as string;
        // Should not have a JSON object after the message
        expect(output).not.toContain("{");
    });

    it("suppresses debug messages at info level", () => {
        logger.setLevel("info");
        logger.debug("should not appear");
        expect(consoleSpy).not.toHaveBeenCalled();
    });

    it("shows debug messages at debug level", () => {
        logger.setLevel("debug");
        logger.debug("debug message");
        expect(consoleSpy).toHaveBeenCalledTimes(1);
        expect(consoleSpy.mock.calls[0][0]).toContain("[DEBUG]");
    });

    it("suppresses info messages at warn level", () => {
        logger.setLevel("warn");
        logger.info("should not appear");
        expect(consoleSpy).not.toHaveBeenCalled();
    });

    it("logs warn messages at warn level", () => {
        logger.setLevel("warn");
        logger.warn("warning");
        expect(consoleSpy).toHaveBeenCalledTimes(1);
        expect(consoleSpy.mock.calls[0][0]).toContain("[WARN]");
    });

    it("always logs error messages regardless of level", () => {
        logger.setLevel("error");
        logger.error("critical failure");
        expect(consoleSpy).toHaveBeenCalledTimes(1);
        expect(consoleSpy.mock.calls[0][0]).toContain("[ERROR]");
    });

    it("error level suppresses warn, info, and debug", () => {
        logger.setLevel("error");
        logger.debug("no");
        logger.info("no");
        logger.warn("no");
        expect(consoleSpy).not.toHaveBeenCalled();
    });

    it("setLevel changes the active threshold", () => {
        logger.setLevel("error");
        logger.info("suppressed");
        expect(consoleSpy).not.toHaveBeenCalled();

        logger.setLevel("info");
        logger.info("now visible");
        expect(consoleSpy).toHaveBeenCalledTimes(1);
    });
});
