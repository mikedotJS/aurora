// The init line Aurora writes into a freshly-spawned zsh (see components/Terminal.tsx).
//
// It blanks the shell's own prompt (Aurora draws the prompt itself, per block) and installs
// OSC 133 shell-integration hooks so the front end can tell where a command starts (`133;C`,
// preexec) and ends (`133;D;<exit>`, precmd). `AuroraReady` tells the pane its shell is usable.
//
// The `_aurora_init` guard exists because this very line installs the hooks *while it is itself
// running*: `preexec` is registered too late to fire for it, but `precmd` fires as soon as it
// finishes. Without the guard zsh's first emission is a `133;D` with no matching `133;C`, which
// ends whatever block Aurora started in the meantime — the Setup Script's block, on workspace
// create. Once its block is closed, `store.appendOutput` drops every subsequent byte, so the
// command looks like it finished instantly with no output while it is in fact still running.
//
// The guard skips exactly that first `precmd`'s `133;D` and nothing else. It deliberately does NOT
// suppress the cwd report (OSC 7), which the first prompt still needs. Note that a `133;D` with no
// preceding `133;C` is otherwise legitimate — an empty line and a syntax error both produce one —
// so this has to be fixed at the source rather than by filtering `133;D` on the front end.
export const ZSH_INIT =
  "PROMPT='' RPROMPT='' PROMPT_EOL_MARK=''; " +
  "_aurora_pe(){ printf '\\e]133;C\\a'; }; " +
  "_aurora_pc(){ local e=$?; if (( ${_aurora_init:-0} )); then _aurora_init=0; " +
  "else printf '\\e]133;D;%s\\a' \"$e\"; fi; " +
  "printf '\\e]7;file://%s%s\\a' \"${HOST:-localhost}\" \"$PWD\"; }; " +
  "_aurora_init=1; " +
  "autoload -Uz add-zsh-hook 2>/dev/null && { add-zsh-hook preexec _aurora_pe; add-zsh-hook precmd _aurora_pc; }; " +
  "printf '\\e]7;file://%s%s\\a' \"${HOST:-localhost}\" \"$PWD\"; printf '\\e]1337;AuroraReady\\a'; clear\n";
