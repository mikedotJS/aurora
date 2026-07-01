// The empty-state surface: shown in the content column (right of the rail)
// whenever there is no active workspace — most notably a legitimately empty
// boot (0 repo context, 0 restored workspaces; see the empty-startup-state
// change). Replaces WorkspaceContextBar + TabStrip + PaneArea for that render.
//
// Exits only through existing flows: "Add repository" reuses addRepoFromFolder
// (same busy/error handling as the rail's own control); "Create a workspace"
// (shown once at least one repo is known) reuses openCommand(). No new create
// logic is introduced here.

import { useState } from "react";
import { useStore } from "../state/store";
import { addRepoFromFolder } from "../lib/repo";

export function EmptyState() {
  const hasRepos = useStore((s) => s.repos.length > 0);
  const openCommand = useStore((s) => s.openCommand);

  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const onAddRepo = async () => {
    if (addBusy) return;
    setAddBusy(true);
    setAddError(null);
    const res = await addRepoFromFolder();
    if ("ok" in res && !res.ok) setAddError(res.error);
    setAddBusy(false);
  };

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 16,
          width: "100%",
          maxWidth: 300,
          padding: "0 24px",
          textAlign: "center",
        }}
      >
        <span style={{ fontFamily: "var(--mono)", fontSize: 15, letterSpacing: ".02em", color: "var(--fg)" }}>
          aurora
        </span>
        <p style={{ margin: 0, fontFamily: "var(--sans)", fontSize: 12.5, color: "var(--dim)", lineHeight: 1.5 }}>
          No workspace open — add a repository to get started.
        </p>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 9, width: "100%" }}>
          <div
            onClick={onAddRepo}
            title="add an existing repository folder"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              fontFamily: "var(--sans)",
              fontSize: 12,
              fontWeight: 500,
              color: "var(--page)",
              background: "var(--ac)",
              border: "1px solid var(--ac)",
              borderRadius: 8,
              padding: "9px 14px",
              cursor: addBusy ? "default" : "pointer",
              opacity: addBusy ? 0.6 : 1,
            }}
          >
            <span>⇋</span>
            {addBusy ? "Opening…" : "Add repository"}
          </div>

          {hasRepos && (
            <div
              onClick={() => openCommand()}
              title="create a workspace (⌘K)"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                fontFamily: "var(--sans)",
                fontSize: 12,
                color: "var(--dim)",
                border: "1px dashed var(--line)",
                borderRadius: 8,
                padding: "9px 14px",
                cursor: "pointer",
              }}
            >
              <span style={{ color: "var(--acd)" }}>+</span>
              Create a workspace
            </div>
          )}
        </div>

        {addError && (
          <div style={{ fontFamily: "var(--sans)", fontSize: 10.5, color: "var(--err)", lineHeight: 1.35 }}>
            {addError}
          </div>
        )}
      </div>
    </div>
  );
}
