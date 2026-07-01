// The empty-state surface: shown in the content column (right of the rail)
// whenever there is no active workspace — most notably a legitimately empty
// boot (0 repo context, 0 restored workspaces; see the empty-startup-state
// change). Replaces WorkspaceContextBar + TabStrip + PaneArea for that render.
//
// It's framed as a live shell prompt — ⇋ aurora ▊, a blown-up echo of the rail's
// own `⇋ <repo>` header — waiting for its first repository. That makes Aurora's
// thesis ("a shell that understands plain language") the literal hero of the
// first screen a new user meets. Exits only through existing flows: "Add
// repository" reuses addRepoFromFolder (same busy/error handling as the rail's
// own control); "Create a workspace" (shown once at least one repo is known)
// reuses openCommand(). No new create logic is introduced here.

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
        padding: 24,
      }}
    >
      <div
        className="aurora-empty"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          width: "100%",
          maxWidth: 344,
          textAlign: "center",
        }}
      >
        {/* Signature: a live shell prompt waiting for its first repo. The ⇋ mark
            and blinking caret are the page's one spot of colour and motion. */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, fontFamily: "var(--mono)" }}>
          <span aria-hidden style={{ fontSize: 19, lineHeight: 1, color: "var(--acd)" }}>
            ⇋
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ fontSize: 21, lineHeight: 1, letterSpacing: ".01em", color: "var(--fg)" }}>
              aurora
            </span>
            <span className="aurora-empty__caret" aria-hidden />
          </span>
        </div>

        {/* Brand thesis — the wordmark's tagline. */}
        <p style={{ margin: "16px 0 0", fontFamily: "var(--sans)", fontSize: 12.5, lineHeight: 1.5, color: "var(--dim)" }}>
          A shell that understands plain language.
        </p>

        {/* State + directive. Kept verbatim as the actionable subtext. */}
        <p
          style={{
            margin: "13px 0 0",
            maxWidth: 264,
            fontFamily: "var(--sans)",
            fontSize: 11.5,
            lineHeight: 1.5,
            color: "var(--faint)",
          }}
        >
          No workspace open — add a repository to get started.
        </p>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "stretch",
            gap: 9,
            width: "100%",
            marginTop: 22,
          }}
        >
          <button
            type="button"
            className="aurora-empty-primary"
            onClick={onAddRepo}
            disabled={addBusy}
            aria-busy={addBusy}
            title="add an existing repository folder"
          >
            <span aria-hidden>⇋</span>
            {addBusy ? "Opening…" : "Add repository"}
          </button>

          {hasRepos && (
            <button
              type="button"
              className="aurora-empty-secondary"
              onClick={() => openCommand()}
              title="create a workspace (⌘K)"
            >
              <span aria-hidden style={{ color: "var(--acd)" }}>
                +
              </span>
              Create a workspace
            </button>
          )}
        </div>

        {addError && (
          <div
            role="alert"
            style={{ marginTop: 12, fontFamily: "var(--sans)", fontSize: 10.5, lineHeight: 1.35, color: "var(--err)" }}
          >
            {addError}
          </div>
        )}
      </div>
    </div>
  );
}
