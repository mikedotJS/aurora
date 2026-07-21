// Rendering for a Servers-tab pane that displays a MANAGED process's own
// output stream ("server:data") instead of a spawned shell PTY — see
// Terminal.tsx, which branches here when `pane.serverId` is set. No xterm
// instance needed: a pane's default (non-raw) scrollback is rendered by
// Pane.tsx straight from `pane.blocks[].output`, so this component's only job
// is to subscribe to the managed process's byte stream and feed it into that
// same block model (batched on rAF, same pattern as the shell path's
// `appendToBlock`). `startBlock`/`endBlock` are driven by lib/servers.ts's
// spawn/poll — not here — since this component doesn't know the command text
// or the process's lifecycle, only its output.

import { useEffect, useRef } from "react";
import { serverHub } from "../lib/server";
import { useStore } from "../state/store";

export function ManagedServerPane({ paneId, serverId }: { paneId: number; serverId: string }) {
  const decoderRef = useRef(new TextDecoder());
  const outBufRef = useRef("");
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    useStore.getState().setReady(paneId);

    const flush = () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (outBufRef.current) {
        useStore.getState().appendOutput(paneId, outBufRef.current);
        outBufRef.current = "";
      }
    };
    const appendToBlock = (t: string) => {
      outBufRef.current += t;
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          flush();
        });
      }
    };

    let disposed = false;
    let unsub: (() => void) | undefined;
    serverHub
      .subscribe(serverId, (bytes) => appendToBlock(decoderRef.current.decode(bytes, { stream: true })))
      .then((fn) => {
        if (disposed) fn();
        else unsub = fn;
      });

    return () => {
      disposed = true;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      unsub?.();
    };
  }, [paneId, serverId]);

  // No visible surface of its own — the block scrollback (Pane.tsx) is the
  // display; this mirrors Terminal.tsx's raw-mode overlay footprint (hidden,
  // non-interactive) so layout is unaffected either way.
  return <div className="aurora-term" style={{ position: "absolute", inset: 0, opacity: 0, pointerEvents: "none" }} />;
}
