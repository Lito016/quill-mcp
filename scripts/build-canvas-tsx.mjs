import { readFileSync, writeFileSync } from "node:fs";

const jsonPath = "c:/Projects/Knowledge/vault/canvases/hive.canvas.json";
const templatePath = "c:/Projects/Knowledge/quill-mcp/templates/hive-canvas-footer.tsx";
const outputPath = process.env.USERPROFILE + "/.qoder/projects/c--Projects-Knowledge/canvases/hive.canvas.tsx";
const vaultRoot = "c:/Projects/Knowledge/vault";

const jsonData = readFileSync(jsonPath, "utf-8");
const template = readFileSync(templatePath, "utf-8");
const cleaned = template.replace(/\/\/ @ts-nocheck[^\n]*\n?/g, "");

const header = `"use client";

import { useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, WheelEvent } from "react";
import { ReportShell } from "qoder/canvas";
const hiveData = ${jsonData};
`;

let tsxContent = header + "\n" + cleaned.replace(/__VAULT_ROOT__/g, vaultRoot);

// Convert CRLF to LF
tsxContent = tsxContent.replace(/\r\n/g, "\n");

// Write with UTF-8 BOM
const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
const content = Buffer.from(tsxContent, "utf-8");
const output = Buffer.concat([bom, content]);

writeFileSync(outputPath, output);
console.log(`TSX written: ${tsxContent.split("\n").length} lines, ${output.length} bytes`);

// Verify folder nodes
const folderCount = (tsxContent.match(/"kind": "folder"/g) || []).length;
console.log(`Folder nodes in TSX: ${folderCount}`);
