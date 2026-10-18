import { readFileSync, writeFileSync } from "node:fs";

const jsonPath = "c:/Projects/Knowledge/vault/canvases/hive.canvas.json";
const data = JSON.parse(readFileSync(jsonPath, "utf-8"));

// Folder detection: group reference nodes by parent directory
const folderChildren = new Map();
for (const node of data.nodes) {
    if (node.kind !== "reference" || !node.path) continue;
    const parts = node.path.replace(/\\/g, "/").split("/");
    if (parts.length <= 2) continue; // root-level (e.g., "projects/file.md")
    const parentDir = parts.slice(0, -1).join("/");
    const key = `${node.group}:${parentDir}`;
    if (!folderChildren.has(key)) folderChildren.set(key, []);
    folderChildren.get(key).push(node);
}

console.log("Folder candidates:");
for (const [key, children] of folderChildren) {
    console.log(`  ${key}: ${children.length} children`);
}

// Create folder hub nodes for folders with 2+ children
const folderHubIds = new Set();
const nodeToFolderHub = new Map();
for (const [key, children] of folderChildren) {
    if (children.length < 2) continue;
    const [group, ...dirParts] = key.split(":");
    const folderDir = dirParts.join(":");
    const folderName = folderDir.split("/").pop();
    const folderId = `folder:${folderDir.replace(/\//g, "-")}`;
    data.nodes.push({
        id: folderId,
        label: folderName.split("-").map(w => w[0]?.toUpperCase() + w.slice(1)).join(" "),
        short: folderName.split("-").map(w => w[0]).join("").slice(0, 2).toUpperCase(),
        kind: "folder",
        group,
        path: folderDir,
        description: `Folder hub - ${children.length} notes`,
        size: "md",
        importance: 45,
    });
    folderHubIds.add(folderId);
    for (const child of children) {
        nodeToFolderHub.set(child.id, folderId);
    }
    console.log(`Created folder hub: ${folderId} (${children.length} children)`);
}

// Rewire links: remove domain→note for folder children, add folder→note
const linksToRemove = new Set();
for (let i = 0; i < data.links.length; i++) {
    const link = data.links[i];
    if (link.type === "member" && nodeToFolderHub.has(link.target)) {
        linksToRemove.add(i);
    }
}
data.links = data.links.filter((_, i) => !linksToRemove.has(i));

// Add folder→note links
for (const [nodeId, folderId] of nodeToFolderHub) {
    data.links.push({ source: folderId, target: nodeId, type: "member" });
}

// Add folder→domain links
for (const folderId of folderHubIds) {
    const folderNode = data.nodes.find(n => n.id === folderId);
    if (folderNode) {
        data.links.push({ source: `domain:${folderNode.group}`, target: folderId, type: "member" });
    }
}

// Update stats
data.stats.nodes = data.nodes.length;
data.stats.edges = data.links.length;
data.schemaVersion = 4;

console.log(`\nFinal: ${data.nodes.length} nodes, ${data.links.length} links`);
writeFileSync(jsonPath, JSON.stringify(data, null, 2), "utf-8");
console.log("JSON updated successfully");
