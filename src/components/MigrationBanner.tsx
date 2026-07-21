// Repo-open migration offer (managed-server-lifecycle task 6.2): a small,
// dismissible strip offering to save the active repo's legacy scripts as a
// committed, team-shareable aurora.json — surfaced whenever such a repo is
// opened/adopted (see lib/auroraConfigStore.ts `checkMigrationOffer`, called
// from lib/repo.ts and App.tsx), not only inside the Scripts panel (that
// narrower banner still lives in ScriptsSheet.tsx, unchanged). Never
// overwrites an existing committed aurora.json — `isUnmigrated` is only true
// when none exists yet.

import { useState } from "react";
import { useStore } from "../state/store";
import { acceptAuroraMigration } from "../lib/auroraConfigStore";

export function MigrationBanner() {
  const root = useStore((s) => s.migrationBannerRepo);
  const dismiss = useStore((s) => s.dismissMigrationBanner);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!root) return null;
  const name = root.split("/").filter(Boolean).pop() ?? root;

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      await acceptAuroraMigration(root);
      dismiss(root);
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 10,
        margin: "8px 12px 0",
        padding: "8px 11px",
        border: "1px solid color-mix(in oklab, var(--ac) 30%, var(--line))",
        borderRadius: 8,
        background: "color-mix(in oklab, var(--ac) 8%, transparent)",
      }}
    >
      <div style={{ flex: 1, minWidth: 0, fontFamily: "var(--sans)", fontSize: 11.5, color: "var(--dim)", lineHeight: 1.4 }}>
        <strong style={{ color: "var(--fg)", fontWeight: 500 }}>{name}</strong> has scripts saved locally only.
        Save them as <code>aurora.json</code> to share with your team?
        {error && <div style={{ color: "var(--err)", marginTop: 3 }}>{error}</div>}
      </div>
      <span
        onClick={busy ? undefined : accept}
        style={{
          flex: "0 0 auto",
          cursor: busy ? "default" : "pointer",
          opacity: busy ? 0.6 : 1,
          fontFamily: "var(--sans)",
          fontSize: 11,
          color: "var(--acd)",
          border: "1px solid var(--line)",
          borderRadius: 6,
          padding: "3px 9px",
        }}
      >
        {busy ? "Saving…" : "Save as aurora.json"}
      </span>
      <span
        onClick={busy ? undefined : () => dismiss(root)}
        title="dismiss"
        style={{ flex: "0 0 auto", cursor: busy ? "default" : "pointer", fontSize: 15, color: "var(--faint)", padding: "0 2px" }}
      >
        ×
      </span>
    </div>
  );
}
