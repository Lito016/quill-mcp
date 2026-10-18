// @ts-nocheck — template consumed as raw text by generate-hive-canvas.ts;
// React types and hiveData are injected at generation time, not available here.

// Hive Canvas Renderer — Graphite console with blue accent
// Uses size/importance metadata from hiveData for visual hierarchy.
// __VAULT_ROOT__ is replaced at generation time with the configured vault path.
const VAULT_ROOT = "__VAULT_ROOT__";

/* ── design tokens ─────────────────────────────────────────────── */

const TOKENS = {
    bg: "#0f172a",
    surface: "#1e293b",
    surfaceHover: "#273548",
    border: "#334155",
    text: "#e2e8f0",
    textMuted: "#94a3b8",
    accent: "#2f5fe3",
    accentLight: "#4f7cff",
    linkDefault: "#334155",
    linkKnowledge: "#4f7cff",
    linkLifecycle: "#10b981",
    linkMember: "#475569",
    linkBridge: "#f59e0b",
    linkFeedback: "#ef4444",
    radius: { sm: 4, md: 8, lg: 12 },
    font: { xs: 10, sm: 11, md: 13, lg: 15 },
};

/* ── size → pixel radius mapping ───────────────────────────────── */

function nodeRadius(size?: string): number {
    switch (size) {
        case "lg": return 40;
        case "md": return 28;
        case "sm": return 18;
        default: return 18;
    }
}

function labelOffset(size?: string): number {
    return nodeRadius(size) + 14;
}

/* ── component ─────────────────────────────────────────────────── */

export default function HiveCanvas() {
    const containerRef = useRef<HTMLDivElement>(null);
    const [zoom, setZoom] = useState(1);
    const [offset, setOffset] = useState({ x: 0, y: 0 });
    const [dragging, setDragging] = useState(false);
    const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
    const [selectedNode, setSelectedNode] = useState<string | null>(null);

    // Build color map from hiveData.groups (semantic, not hardcoded)
    const groupColorMap = useMemo(() => {
        const map: Record<string, string> = {};
        for (const g of hiveData.groups ?? []) {
            map[g.id] = g.color;
        }
        return map;
    }, []);

    // Kind-based palette for structural nodes (core, agent, domain, folder)
    const kindColorMap: Record<string, string> = {
        core: "#2f5fe3",
        agent: "#4f7cff",
        domain: "#374151",
        folder: "#4b5563",
        skill: "#6b7280",
        reference: "#9ca3af",
        concept: "#64748b",
    };

    const selectedNodeData = useMemo(() => {
        if (!selectedNode) return null;
        return (hiveData.nodes ?? []).find((n: any) => n.id === selectedNode) ?? null;
    }, [selectedNode]);

    // Force-directed layout weighted by importance
    const layoutNodes = useMemo(() => {
        const nodes = hiveData.nodes ?? [];
        const links = hiveData.links ?? [];

        const positions: Record<string, { x: number; y: number; vx: number; vy: number }> = {};

        // Place core at center, others in rings by importance
        nodes.forEach((node: any, i: number) => {
            const importance = node.importance ?? 20;
            const ring = importance >= 80 ? 0 : importance >= 60 ? 120 : importance >= 40 ? 240 : 360;
            const angle = (i / nodes.length) * Math.PI * 2 + (ring * 0.1);
            positions[node.id] = {
                x: Math.cos(angle) * ring,
                y: Math.sin(angle) * ring,
                vx: 0,
                vy: 0,
            };
        });

        // Simulation parameters
        const iterations = 80;
        const repulsion = 6000;
        const attraction = 0.008;
        const damping = 0.85;
        const centerPull = 0.002;

        for (let iter = 0; iter < iterations; iter++) {
            // Repulsion between all nodes
            for (let i = 0; i < nodes.length; i++) {
                for (let j = i + 1; j < nodes.length; j++) {
                    const a = positions[nodes[i].id];
                    const b = positions[nodes[j].id];
                    const dx = b.x - a.x;
                    const dy = b.y - a.y;
                    const dist = Math.sqrt(dx * dx + dy * dy) + 0.1;
                    const force = repulsion / (dist * dist);
                    const fx = (dx / dist) * force;
                    const fy = (dy / dist) * force;
                    a.vx -= fx;
                    a.vy -= fy;
                    b.vx += fx;
                    b.vy += fy;
                }
            }

            // Attraction along links (stronger for knowledge/lifecycle links)
            for (const link of links) {
                const source = positions[link.source];
                const target = positions[link.target];
                if (!source || !target) continue;
                const dx = target.x - source.x;
                const dy = target.y - source.y;
                const dist = Math.sqrt(dx * dx + dy * dy) + 0.1;
                const linkStrength = link.type === "lifecycle" ? 0.02 : link.type === "knowledge" ? 0.012 : attraction;
                const force = dist * linkStrength;
                const fx = (dx / dist) * force;
                const fy = (dy / dist) * force;
                source.vx += fx;
                source.vy += fy;
                target.vx -= fx;
                target.vy -= fy;
            }

            // Center pull weighted by importance (high importance = stronger pull to center)
            for (const node of nodes) {
                const pos = positions[node.id];
                const importance = node.importance ?? 20;
                const pull = centerPull * (importance / 50);
                pos.vx -= pos.x * pull;
                pos.vy -= pos.y * pull;
            }

            // Update positions
            for (const node of nodes) {
                const pos = positions[node.id];
                pos.vx *= damping;
                pos.vy *= damping;
                pos.x += pos.vx;
                pos.y += pos.vy;
            }
        }

        return positions;
    }, []);

    const handleWheel = (e: WheelEvent) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        setZoom((z) => Math.max(0.1, Math.min(5, z * delta)));
    };

    const handleMouseDown = (e: ReactMouseEvent) => {
        setDragging(true);
        setDragStart({ x: e.clientX - offset.x, y: e.clientY - offset.y });
    };

    const handleMouseUp = () => setDragging(false);

    const handleMouseMove = (e: ReactMouseEvent) => {
        if (!dragging) return;
        setOffset({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
    };

    const nodes = hiveData.nodes ?? [];
    const links = hiveData.links ?? [];

    const linkColor = (type: string): string => {
        switch (type) {
            case "knowledge": return TOKENS.linkKnowledge;
            case "lifecycle": return TOKENS.linkLifecycle;
            case "member": return TOKENS.linkMember;
            case "bridge": return TOKENS.linkBridge;
            case "feedback": return TOKENS.linkFeedback;
            default: return TOKENS.linkDefault;
        }
    };

    return (
        <div
            ref={containerRef}
            style={{
                width: "100%",
                height: "100vh",
                overflow: "hidden",
                background: TOKENS.bg,
                position: "relative",
                fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
            }}
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
            onMouseMove={handleMouseMove}
        >
            {/* Title bar */}
            <div style={{
                position: "absolute",
                top: 16,
                left: 16,
                zIndex: 10,
                color: TOKENS.text,
            }}>
                <div style={{ fontSize: TOKENS.font.lg, fontWeight: 600, letterSpacing: "-0.01em" }}>
                    {hiveData.title}
                </div>
                <div style={{ fontSize: TOKENS.font.sm, color: TOKENS.textMuted, marginTop: 2 }}>
                    {hiveData.subtitle}
                </div>
            </div>

            {/* Legend */}
            <div style={{
                position: "absolute",
                top: 16,
                right: 16,
                zIndex: 10,
                background: TOKENS.surface,
                borderRadius: TOKENS.radius.lg,
                padding: "10px 14px",
                border: `1px solid ${TOKENS.border}`,
                display: "flex",
                flexWrap: "wrap",
                gap: "6px 14px",
                maxWidth: 360,
            }}>
                {(hiveData.groups ?? []).map((g: any) => (
                    <div key={g.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <div style={{ width: 10, height: 10, borderRadius: "50%", background: g.color }} />
                        <span style={{ fontSize: TOKENS.font.xs, color: TOKENS.textMuted }}>{g.label}</span>
                    </div>
                ))}
            </div>

            {/* Canvas */}
            <svg
                style={{
                    width: "100%",
                    height: "100%",
                    transform: `translate(${offset.x + 800}px,${offset.y + 450}px) scale(${zoom})`,
                }}
            >
                {/* Links */}
                {links.map((link: any, i: number) => {
                    const source = layoutNodes[link.source];
                    const target = layoutNodes[link.target];
                    if (!source || !target) return null;
                    return (
                        <line
                            key={i}
                            x1={source.x}
                            y1={source.y}
                            x2={target.x}
                            y2={target.y}
                            stroke={linkColor(link.type)}
                            strokeWidth={link.type === "lifecycle" ? 2 : 1}
                            strokeDasharray={link.type === "feedback" ? "4 3" : undefined}
                            opacity={0.6}
                        />
                    );
                })}

                {/* Nodes */}
                {nodes.map((node: any) => {
                    const pos = layoutNodes[node.id];
                    if (!pos) return null;
                    const r = nodeRadius(node.size);
                    const isStructural = ["core", "agent", "domain", "folder"].includes(node.kind);
                    const color = isStructural ? (kindColorMap[node.kind] ?? TOKENS.textMuted) : (groupColorMap[node.group] ?? TOKENS.textMuted);
                    const isSelected = selectedNode === node.id;
                    return (
                        <g
                            key={node.id}
                            transform={`translate(${pos.x},${pos.y})`}
                            onClick={() => setSelectedNode(node.id)}
                            style={{ cursor: "pointer" }}
                        >
                            {/* Glow ring for selected */}
                            {isSelected && (
                                <circle r={r + 6} fill="none" stroke={TOKENS.accentLight} strokeWidth={2} opacity={0.5} />
                            )}
                            {/* Node circle */}
                            <circle
                                r={r}
                                fill={color}
                                opacity={node.kind === "core" ? 1 : node.kind === "folder" ? 0.9 : 0.8}
                                stroke={isSelected ? TOKENS.accentLight : node.kind === "folder" ? "#6b7280" : "transparent"}
                                strokeWidth={isSelected ? 2 : node.kind === "folder" ? 1.5 : 0}
                                strokeDasharray={node.kind === "folder" ? "4 2" : undefined}
                            />
                            {/* Short label inside node (for md/lg) */}
                            {r >= 28 && (
                                <text
                                    textAnchor="middle"
                                    dy={4}
                                    fill="#fff"
                                    fontSize={r >= 40 ? 16 : 12}
                                    fontWeight={600}
                                    style={{ pointerEvents: "none" }}
                                >
                                    {node.short}
                                </text>
                            )}
                            {/* Full label below */}
                            <text
                                textAnchor="middle"
                                dy={labelOffset(node.size)}
                                fill={TOKENS.text}
                                fontSize={r >= 40 ? TOKENS.font.md : TOKENS.font.sm}
                                fontWeight={node.kind === "core" ? 600 : node.kind === "folder" || node.kind === "domain" ? 500 : 400}
                                style={{ pointerEvents: "none" }}
                            >
                                {node.label ?? node.id}
                            </text>
                        </g>
                    );
                })}
            </svg>

            {/* Detail panel */}
            {selectedNodeData && (
                <div
                    style={{
                        position: "absolute",
                        bottom: 16,
                        left: 16,
                        background: TOKENS.surface,
                        padding: 16,
                        borderRadius: TOKENS.radius.lg,
                        color: TOKENS.text,
                        maxWidth: 380,
                        border: `1px solid ${TOKENS.border}`,
                        boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
                    }}
                >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                        <div style={{
                            width: 12,
                            height: 12,
                            borderRadius: "50%",
                            background: groupColorMap[selectedNodeData.group] ?? TOKENS.textMuted,
                        }} />
                        <strong style={{ fontSize: TOKENS.font.md }}>{selectedNodeData.label}</strong>
                        <span style={{
                            fontSize: TOKENS.font.xs,
                            color: TOKENS.textMuted,
                            background: TOKENS.bg,
                            padding: "2px 6px",
                            borderRadius: TOKENS.radius.sm,
                        }}>
                            {selectedNodeData.kind}
                        </span>
                    </div>
                    {selectedNodeData.description && (
                        <p style={{
                            margin: "0 0 8px",
                            fontSize: TOKENS.font.sm,
                            color: TOKENS.textMuted,
                            lineHeight: 1.5,
                        }}>
                            {selectedNodeData.description.slice(0, 200)}
                            {selectedNodeData.description.length > 200 ? "…" : ""}
                        </p>
                    )}
                    {selectedNodeData.path && (
                        <a
                            href={`vscode://file/${VAULT_ROOT}/${selectedNodeData.path}`}
                            style={{
                                fontSize: TOKENS.font.sm,
                                color: TOKENS.accentLight,
                                textDecoration: "none",
                            }}
                        >
                            Open in editor →
                        </a>
                    )}
                    <button
                        onClick={() => setSelectedNode(null)}
                        style={{
                            position: "absolute",
                            top: 8,
                            right: 8,
                            background: "transparent",
                            border: "none",
                            color: TOKENS.textMuted,
                            cursor: "pointer",
                            fontSize: 16,
                            padding: 4,
                        }}
                    >
                        ×
                    </button>
                </div>
            )}

            {/* Stats */}
            <div style={{
                position: "absolute",
                bottom: 16,
                right: 16,
                fontSize: TOKENS.font.xs,
                color: TOKENS.textMuted,
                background: TOKENS.surface,
                padding: "6px 10px",
                borderRadius: TOKENS.radius.md,
                border: `1px solid ${TOKENS.border}`,
            }}>
                {hiveData.stats?.nodes ?? nodes.length} nodes · {hiveData.stats?.edges ?? links.length} edges
                {(hiveData.stats?.warnings ?? 0) > 0 && ` · ${hiveData.stats.warnings} warnings`}
            </div>
        </div>
    );
}
