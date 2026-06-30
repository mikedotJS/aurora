// Renders every tab group (only the active one visible) so background sessions
// keep their PTYs alive. Each group lays its panes out in the Aurora grid.

import { useStore, type Group } from "../state/store";
import { Pane } from "./Pane";

function gridShape(n: number, split: "h" | "v") {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n <= 3) return split === "v" ? { cols: 1, rows: n } : { cols: n, rows: 1 };
  const cols = Math.ceil(Math.sqrt(n));
  return { cols, rows: Math.ceil(n / cols) };
}

function GroupGrid({ group, visible }: { group: Group; visible: boolean }) {
  const n = group.panes.length;
  const multiple = n > 1;
  const { cols, rows } = gridShape(n, group.split);
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: visible ? "grid" : "none",
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
        gap: multiple ? 6 : 0,
        padding: multiple ? 6 : 0,
        background: "var(--page)",
      }}
    >
      {group.panes.map((p, i) => (
        <Pane key={p.id} pane={p} index={i} isActive={i === group.active} multiple={multiple} />
      ))}
    </div>
  );
}

export function PaneArea() {
  // Render every workspace's groups so background PTYs stay alive across a
  // workspace switch; only the active workspace's active tab is visible.
  const workspaces = useStore((s) => s.workspaces);
  const activeWs = useStore((s) => s.activeWs);
  return (
    <div style={{ flex: 1, minHeight: 0, position: "relative", background: "var(--page)" }}>
      {workspaces
        .filter((w) => w.mounted)
        .flatMap((w) =>
          w.tabs.map((group, gi) => (
            <GroupGrid key={group.id} group={group} visible={w.id === activeWs && gi === w.active} />
          )),
        )}
    </div>
  );
}
