// Headless stubs for @xterm/xterm + @xterm/addon-fit so Terminal.tsx can mount
// under happy-dom without a real canvas/DOM renderer. Records writes so tests
// can assert on terminal output.

export class XTerm {
  options: Record<string, unknown>;
  cols = 80;
  rows = 24;
  element: HTMLElement | null = null;
  written: string[] = [];
  private dataCbs: Array<(d: string) => void> = [];
  private resizeCbs: Array<(e: { cols: number; rows: number }) => void> = [];

  constructor(options: Record<string, unknown> = {}) {
    this.options = { ...options };
  }
  open(el: HTMLElement) {
    this.element = el;
  }
  loadAddon(addon: { activate?: (t: XTerm) => void }) {
    addon.activate?.(this);
  }
  onData(cb: (d: string) => void) {
    this.dataCbs.push(cb);
    return { dispose: () => {} };
  }
  onResize(cb: (e: { cols: number; rows: number }) => void) {
    this.resizeCbs.push(cb);
    return { dispose: () => {} };
  }
  write(data: string | Uint8Array) {
    this.written.push(typeof data === "string" ? data : new TextDecoder().decode(data));
  }
  paste(data: string) {
    this.written.push(data);
  }
  focus() {}
  blur() {}
  clear() {}
  reset() {}
  scrollToBottom() {}
  attachCustomKeyEventHandler(_h: (e: KeyboardEvent) => boolean) {}
  hasSelection() {
    return false;
  }
  getSelection() {
    return "";
  }
  dispose() {
    this.dataCbs = [];
    this.resizeCbs = [];
    this.element = null;
  }
  // test helpers
  _emitData(d: string) {
    this.dataCbs.forEach((cb) => cb(d));
  }
  _emitResize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.resizeCbs.forEach((cb) => cb({ cols, rows }));
  }
}

export class FitAddon {
  private term: XTerm | null = null;
  activate(t: XTerm) {
    this.term = t;
  }
  fit() {
    // no-op; keep current cols/rows
    void this.term;
  }
  proposeDimensions() {
    return { cols: this.term?.cols ?? 80, rows: this.term?.rows ?? 24 };
  }
  dispose() {}
}
