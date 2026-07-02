"use client";

import { useState, useEffect } from "react";
import type { ToolEntry } from "./ToolPanel";

interface Props {
  cwd: string | null;
  onClose: () => void;
}

export function ToolsConfig({ cwd, onClose }: Props) {
  const [tools, setTools] = useState<ToolEntry[]>([]);
  const [active, setActive] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  // Fetch tools via the tools API (doesn't need active session)
  useEffect(() => {
    if (!cwd) {
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const res = await fetch(`/api/tools?cwd=${encodeURIComponent(cwd)}`);
        const d = await res.json();
        if (d.tools && Array.isArray(d.tools) && d.tools.length > 0) {
          setTools(d.tools);
          const initialActive = new Set<string>(d.tools.filter((t: ToolEntry) => t.active).map((t: ToolEntry) => t.name));
          setActive(initialActive);
          // Select first tool by default
          setSelected(d.tools[0].name);
        }
      } catch (e) {
        console.error("Failed to fetch tools:", e);
      } finally {
        setLoading(false);
      }
    })();
  }, [cwd]);

  // Group tools by category
  const builtinTools = tools.filter(t => ["read", "bash", "edit", "write", "grep", "find", "ls"].includes(t.name));
  const extensionTools = tools.filter(t => !["read", "bash", "edit", "write", "grep", "find", "ls"].includes(t.name));
  const systemExtensions = extensionTools.filter(t => t.sourceInfo?.scope === "user");
  const projectExtensions = extensionTools.filter(t => t.sourceInfo?.scope === "project");
  const otherTools = extensionTools.filter(t => t.sourceInfo?.scope !== "user" && t.sourceInfo?.scope !== "project");

  const selectedTool = tools.find(t => t.name === selected) ?? null;

  const toggle = (name: string) => {
    setActive(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const setAll = (enabled: boolean) => {
    if (enabled) {
      setActive(new Set(tools.map(t => t.name)));
    } else {
      setActive(new Set());
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const names = [...active];
      await fetch("/api/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activeTools: names }),
      });
      onClose();
    } catch (e) {
      console.error("Failed to save tools config:", e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: 680,
          maxWidth: "calc(100vw - 16px)",
          height: "76vh",
          maxHeight: "calc(100dvh - 16px)",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 18px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
            Tools
          </span>
          {tools.length > 0 && (
            <div style={{ display: "flex", gap: 6 }}>
              <button
                onClick={() => setAll(true)}
                style={{
                  padding: "4px 10px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "none",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: 11,
                }}
              >
                Enable all
              </button>
              <button
                onClick={() => setAll(false)}
                style={{
                  padding: "4px 10px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "none",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: 11,
                }}
              >
                Disable all
              </button>
            </div>
          )}
        </div>

        {/* Body: left-right split */}
        <div style={{ flex: 1, display: "flex", flexDirection: "row", overflow: "hidden" }}>
          {/* Left sidebar: tool list */}
          <div
            style={{
              width: 245,
              borderRight: "1px solid var(--border)",
              display: "flex",
              flexDirection: "column",
              flexShrink: 0,
              background: "var(--bg-panel)",
            }}
          >
            <div style={{ flex: 1, overflowY: "auto", padding: "8px 6px" }}>
              {loading ? (
                <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--text-muted)" }}>
                  Loading...
                </div>
              ) : tools.length === 0 ? (
                <div style={{ padding: "10px 8px", fontSize: 11, color: "var(--text-dim)" }}>
                  No tools available. Select a workspace directory first.
                </div>
              ) : (
                <>
                  {builtinTools.length > 0 && (
                    <ToolGroup
                      label="Built-in"
                      tools={builtinTools}
                      active={active}
                      selected={selected}
                      onSelect={setSelected}
                    />
                  )}
                  {systemExtensions.length > 0 && (
                    <ToolGroup
                      label="Extensions · System"
                      tools={systemExtensions}
                      active={active}
                      selected={selected}
                      onSelect={setSelected}
                    />
                  )}
                  {projectExtensions.length > 0 && (
                    <ToolGroup
                      label="Extensions · Project"
                      tools={projectExtensions}
                      active={active}
                      selected={selected}
                      onSelect={setSelected}
                    />
                  )}
                  {otherTools.length > 0 && (
                    <ToolGroup
                      label="Extensions · Other"
                      tools={otherTools}
                      active={active}
                      selected={selected}
                      onSelect={setSelected}
                    />
                  )}
                </>
              )}
            </div>
          </div>

          {/* Right: tool detail */}
          <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
            {loading ? null : selectedTool ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                {/* Tool header with toggle */}
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <ToggleSwitch
                    enabled={active.has(selectedTool.name)}
                    onToggle={() => toggle(selectedTool.name)}
                  />
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-mono)" }}>
                      {selectedTool.name}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
                      {selectedTool.description}
                    </div>
                  </div>
                </div>

                {/* Source info */}
                {selectedTool.sourceInfo && (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "minmax(80px, 100px) minmax(0, 1fr)",
                      gap: "8px 14px",
                      fontSize: 12,
                      lineHeight: 1.45,
                    }}
                  >
                    {selectedTool.sourceInfo.scope && (
                      <>
                        <div style={{ color: "var(--text-dim)" }}>Scope</div>
                        <div style={{ color: "var(--text-muted)" }}>
                          <ScopeTag scope={selectedTool.sourceInfo.scope} />
                        </div>
                      </>
                    )}
                    {selectedTool.sourceInfo.source && (
                      <>
                        <div style={{ color: "var(--text-dim)" }}>Source</div>
                        <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
                          {selectedTool.sourceInfo.source}
                        </div>
                      </>
                    )}
                    {selectedTool.sourceInfo.path && (
                      <>
                        <div style={{ color: "var(--text-dim)" }}>Path</div>
                        <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
                          {selectedTool.sourceInfo.path}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div
                style={{
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--text-dim)",
                  fontSize: 13,
                }}
              >
                {tools.length === 0 ? "No tools available" : "Select a tool"}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 18px",
            borderTop: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
            Takes effect on next new session
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={onClose}
              style={{
                padding: "6px 16px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || loading || tools.length === 0}
              style={{
                padding: "6px 16px",
                borderRadius: 8,
                border: "none",
                background: "var(--accent)",
                color: "#fff",
                cursor: saving || loading || tools.length === 0 ? "default" : "pointer",
                fontSize: 12,
                opacity: saving || loading || tools.length === 0 ? 0.6 : 1,
              }}
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ToolGroup({
  label,
  tools,
  active,
  selected,
  onSelect,
}: {
  label: string;
  tools: ToolEntry[];
  active: Set<string>;
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div
        style={{
          padding: "4px 8px 3px",
          fontSize: 10,
          fontWeight: 600,
          color: "var(--text-dim)",
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      {tools.map(tool => {
        const isSelected = selected === tool.name;
        const isActive = active.has(tool.name);
        return (
          <div
            key={tool.name}
            onClick={() => onSelect(tool.name)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "7px 8px",
              borderRadius: 5,
              cursor: "pointer",
              background: isSelected ? "var(--bg-selected)" : "none",
            }}
            onMouseEnter={(e) => {
              if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)";
            }}
            onMouseLeave={(e) => {
              if (!isSelected) e.currentTarget.style.background = "none";
            }}
          >
            <span
              style={{
                flexShrink: 0,
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: isActive ? "var(--accent)" : "var(--border)",
              }}
            />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: isSelected ? 600 : 400,
                  color: "var(--text)",
                  fontFamily: "var(--font-mono)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {tool.name}
              </div>
              <div
                style={{
                  fontSize: 10,
                  color: "var(--text-dim)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  marginTop: 1,
                }}
              >
                {tool.description}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ToggleSwitch({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={enabled}
      style={{
        flexShrink: 0,
        width: 40,
        height: 22,
        borderRadius: 11,
        border: "none",
        padding: 0,
        cursor: "pointer",
        background: enabled ? "var(--accent)" : "var(--border)",
        position: "relative",
        transition: "background 0.18s",
        outline: "none",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: enabled ? 21 : 3,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "var(--bg)",
          boxShadow: "0 1px 4px rgba(0,0,0,0.22)",
          transition: "left 0.18s cubic-bezier(.4,0,.2,1)",
        }}
      />
    </button>
  );
}

function ScopeTag({ scope }: { scope: string }) {
  return (
    <span
      style={{
        fontSize: 10,
        padding: "1px 5px",
        borderRadius: 3,
        background: scope === "project" ? "rgba(99,102,241,0.12)" : "rgba(120,120,120,0.12)",
        color: scope === "project" ? "rgba(99,102,241,0.85)" : "var(--text-dim)",
      }}
    >
      {scope}
    </span>
  );
}
