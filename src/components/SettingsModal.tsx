// Settings modal: Claude (key + model), Appearance (accent + text size),
// Shell (ghost autocomplete + Claude suggestions). Persisted via the store.

import type { ReactNode, CSSProperties } from "react";
import { useStore, MODEL_OPTIONS, type Settings } from "../state/store";
import { ACCENTS, type AccentKey, type FontKey } from "../lib/theme";
import { keyDelete } from "../lib/keychain";
import { Connections } from "./Connections";

const FONT_OPTIONS: { value: FontKey; label: string }[] = [
  { value: "compact", label: "Compact" },
  { value: "cozy", label: "Cozy" },
  { value: "large", label: "Large" },
];

function Section({ title }: { title: string }) {
  return (
    <div
      style={{
        padding: "15px 18px 7px",
        fontFamily: "var(--sans)",
        fontSize: 10.5,
        letterSpacing: ".09em",
        textTransform: "uppercase",
        color: "var(--faint)",
      }}
    >
      {title}
    </div>
  );
}

function Row({ label, desc, children }: { label: string; desc: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "9px 18px" }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontFamily: "var(--sans)", fontSize: 13, color: "var(--fg)" }}>{label}</div>
        <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 2 }}>{desc}</div>
      </div>
      <div style={{ display: "flex", gap: 7, flex: "0 0 auto", alignItems: "center" }}>{children}</div>
    </div>
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 3,
        background: "var(--page)",
        border: "1px solid var(--line)",
        borderRadius: 8,
        padding: 3,
      }}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <span
            key={o.value}
            onClick={() => onChange(o.value)}
            style={{
              fontFamily: "var(--sans)",
              fontSize: 11.5,
              color: on ? "var(--page)" : "var(--dim)",
              background: on ? "var(--ac)" : "transparent",
              borderRadius: 6,
              padding: "4px 10px",
              fontWeight: on ? 500 : 400,
              cursor: on ? "default" : "pointer",
            }}
          >
            {o.label}
          </span>
        );
      })}
    </div>
  );
}

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <div
      onClick={onToggle}
      style={{
        width: 38,
        height: 21,
        borderRadius: 999,
        background: on ? "var(--ac)" : "var(--line)",
        position: "relative",
        cursor: "pointer",
        flex: "0 0 auto",
        transition: "background .15s",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: on ? 19 : 2,
          width: 17,
          height: 17,
          borderRadius: "50%",
          background: on ? "var(--page)" : "var(--dim)",
          transition: "left .15s",
        }}
      />
    </div>
  );
}

export function SettingsModal() {
  const settings = useStore((s) => s.settings);
  const apiKeyPresent = useStore((s) => s.apiKeyPresent);
  const setSetting = useStore((s) => s.setSetting);
  const closeSettings = useStore((s) => s.closeSettings);
  const startKeyEntry = useStore((s) => s.startKeyEntry);
  const setApiKeyPresent = useStore((s) => s.setApiKeyPresent);
  const muted = useStore((s) => s.muted);
  const toggleMute = useStore((s) => s.toggleMute);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setSetting(k, v);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 30,
      }}
    >
      <div
        onClick={closeSettings}
        style={{
          position: "absolute",
          inset: 0,
          background: "color-mix(in oklab, black 55%, transparent)",
          animation: "fadeIn .16s ease",
        }}
      />
      <div
        style={{
          position: "relative",
          width: "min(520px, 100%)",
          maxHeight: "100%",
          display: "flex",
          flexDirection: "column",
          background: "var(--win)",
          border: "1px solid var(--line)",
          borderRadius: 14,
          boxShadow: "0 34px 90px -26px rgba(0,0,0,.82)",
          animation: "popIn .2s cubic-bezier(.2,.7,.2,1)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            flex: "0 0 auto",
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "15px 18px",
            borderBottom: "1px solid var(--line)",
          }}
        >
          <span style={{ color: "var(--acd)", fontSize: 14 }}>⚙</span>
          <span style={{ fontFamily: "var(--sans)", fontSize: 13.5, color: "var(--fg)", fontWeight: 500 }}>
            Settings
          </span>
          <span
            onClick={closeSettings}
            style={{
              marginLeft: "auto",
              cursor: "pointer",
              fontSize: 18,
              width: 24,
              height: 24,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 7,
              color: "var(--dim)",
            }}
          >
            ×
          </span>
        </div>

        <div className="ascroll" style={{ flex: 1, overflowY: "auto", padding: "4px 0 14px" }}>
          <Section title="Claude" />
          <Row label="Anthropic API key" desc={apiKeyPresent ? "stored in macOS Keychain" : "no key set"}>
            <span
              onClick={() => {
                closeSettings();
                startKeyEntry();
              }}
              style={pillStyle}
            >
              {apiKeyPresent ? "update" : "add"}
            </span>
            {apiKeyPresent && (
              <span
                onClick={async () => {
                  await keyDelete();
                  setApiKeyPresent(false);
                }}
                style={{ ...pillStyle, color: "var(--dim)" }}
              >
                remove
              </span>
            )}
          </Row>
          <Row label="Model" desc="Used for command suggestions">
            <Segmented
              options={MODEL_OPTIONS}
              value={settings.model}
              onChange={(v) => set("model", v)}
            />
          </Row>

          <Connections />

          <Section title="Appearance" />
          <Row label="Accent" desc="Glow and highlight color">
            {(Object.keys(ACCENTS) as AccentKey[]).map((k) => (
              <span
                key={k}
                onClick={() => set("accent", k)}
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 6,
                  background: ACCENTS[k][0],
                  cursor: "pointer",
                  boxShadow: `0 0 0 2px ${k === settings.accent ? "var(--fg)" : "transparent"}, 0 0 10px -3px ${ACCENTS[k][0]}`,
                }}
              />
            ))}
          </Row>
          <Row label="Text size" desc="Terminal scrollback density">
            <Segmented options={FONT_OPTIONS} value={settings.fontSize} onChange={(v) => set("fontSize", v)} />
          </Row>

          <Section title="Shell" />
          <Row label="Ghost autocomplete" desc="Inline command completion as you type">
            <Toggle on={settings.ghost} onToggle={() => set("ghost", !settings.ghost)} />
          </Row>
          <Row label="Auto-rename tabs" desc="Name tabs from what's running — a quick Haiku call">
            <Toggle on={settings.autoRenameTabs} onToggle={() => set("autoRenameTabs", !settings.autoRenameTabs)} />
          </Row>
          <Row label="Ask Claude" desc="? prefix or ⌘↵ turns a line into a command">
            <span style={{ fontFamily: "var(--sans)", fontSize: 11, color: "var(--faint)" }}>
              {apiKeyPresent ? "ready" : "needs key"}
            </span>
          </Row>

          <Section title="Notifications" />
          <Row label="Merge request alerts" desc="Notify on new / updated / ready MRs">
            <Toggle on={settings.notifyMr} onToggle={() => set("notifyMr", !settings.notifyMr)} />
          </Row>
          <Row label="Do not disturb" desc="Silence toasts — history still records">
            <Toggle on={muted} onToggle={toggleMute} />
          </Row>
        </div>
      </div>
    </div>
  );
}

const pillStyle: CSSProperties = {
  cursor: "pointer",
  fontFamily: "var(--sans)",
  fontSize: 11,
  color: "var(--acd)",
  border: "1px solid var(--line)",
  borderRadius: 6,
  padding: "4px 9px",
};
