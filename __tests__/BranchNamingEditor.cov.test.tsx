// Line-coverage suite for src/components/BranchNamingEditor.tsx — the four-mode
// branch-naming editor (manual template / package.json / validator / AI).
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { useState } from "react";
import { render, fireEvent, cleanup, screen, waitFor, act } from "@testing-library/react";
import { tauri } from "../test/mocks/tauri";
import { BranchNamingEditor } from "../src/components/BranchNamingEditor";
import { applyTemplate, type BranchNamingConfig, type NameIssue } from "../src/lib/branchNaming";
import { useStore } from "../src/state/store";
import { DEFAULT_SETTINGS } from "../src/state/store";

const SAMPLE: NameIssue = {
  key: "PROJ-1423",
  type: "Bug",
  title: "Login redirect drops the return URL",
  component: "api",
  assignee: "you",
  sprint: "24",
};

/** Controlled harness: keeps `value` in local state so onChange round-trips
 *  and the component re-renders the way it would inside the real app. */
function Controlled({
  initial,
  repoDir = "/repo",
  spy,
}: {
  initial: BranchNamingConfig;
  repoDir?: string;
  spy?: (cfg: BranchNamingConfig) => void;
}) {
  const [value, setValue] = useState<BranchNamingConfig>(initial);
  return (
    <BranchNamingEditor
      value={value}
      repoDir={repoDir}
      onChange={(cfg) => {
        spy?.(cfg);
        setValue(cfg);
      }}
    />
  );
}

beforeEach(() => {
  tauri.reset();
  useStore.setState({ settings: { ...DEFAULT_SETTINGS } }, false);
});
afterEach(cleanup);

describe("source selector", () => {
  it("switches from manual to each other source with the documented defaults", () => {
    const changes: BranchNamingConfig[] = [];
    render(<Controlled initial={{ source: "manual", template: "{key}/{slug}" }} spy={(c) => changes.push(c)} />);

    fireEvent.click(screen.getByText("package.json"));
    expect(changes.at(-1)).toEqual({ source: "package-json", field: "aurora.branchPattern" });

    fireEvent.click(screen.getByText("Validator"));
    expect(changes.at(-1)).toEqual({ source: "validator", regex: "", groups: [] });

    fireEvent.click(screen.getByText("AI"));
    expect(changes.at(-1)).toEqual({
      source: "ai",
      instruction: "Name branches as <type>/<key>-<short-slug>.",
      chainValidator: true,
    });

    fireEvent.click(screen.getByText("Template"));
    expect(changes.at(-1)).toEqual({ source: "manual", template: "{key}/{slug}" });
  });

  it("does nothing when clicking the already-active source tab", () => {
    const changes: BranchNamingConfig[] = [];
    render(<Controlled initial={{ source: "manual", template: "{key}/{slug}" }} spy={(c) => changes.push(c)} />);
    // "Template" also labels the manual editor's field below the tab strip —
    // the tab itself is the first match in DOM order.
    fireEvent.click(screen.getAllByText("Template")[0]);
    expect(changes.length).toBe(0);
  });
});

describe("ManualEditor", () => {
  it("renders the template input and a live sample preview", () => {
    render(<Controlled initial={{ source: "manual", template: "{key}/{slug}" }} />);
    const input = screen.getByDisplayValue("{key}/{slug}") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(screen.getByText(applyTemplate("{key}/{slug}", SAMPLE))).toBeTruthy();
    expect(screen.getByText(`Sample · ${SAMPLE.key} (${SAMPLE.type}) “${SAMPLE.title}”`)).toBeTruthy();
  });

  it("updates the template on direct input and re-renders the preview", () => {
    render(<Controlled initial={{ source: "manual", template: "{key}/{slug}" }} />);
    const input = screen.getByDisplayValue("{key}/{slug}") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "{type}/{slug}" } });
    expect(screen.getByDisplayValue("{type}/{slug}")).toBeTruthy();
    expect(screen.getByText(applyTemplate("{type}/{slug}", SAMPLE))).toBeTruthy();
  });

  it("appends a token to the template when a token chip is clicked", () => {
    render(<Controlled initial={{ source: "manual", template: "{key}" }} />);
    fireEvent.click(screen.getByText("{slug}"));
    expect(screen.getByDisplayValue("{key}{slug}")).toBeTruthy();
  });

  it("shows an em dash placeholder when the template resolves to an empty preview", () => {
    render(<Controlled initial={{ source: "manual", template: "" }} />);
    expect(screen.getByText("—")).toBeTruthy();
  });
});

describe("PackageJsonEditor", () => {
  it("shows 'not found' and no preview when the field is absent from package.json", async () => {
    tauri.invoke({ read_package_field: () => null });
    render(<Controlled initial={{ source: "package-json", field: "aurora.branchPattern" }} />);
    await waitFor(() => expect(screen.getByText("not found in package.json")).toBeTruthy());
    expect(screen.queryByText("Preview")).toBeNull();
    expect(tauri.lastCall("read_package_field")?.args).toEqual({ dir: "/repo", field: "aurora.branchPattern" });
  });

  it("shows the bound pattern and a computed preview when the field is present", async () => {
    tauri.invoke({ read_package_field: () => "{type}/{slug}" });
    render(<Controlled initial={{ source: "package-json", field: "aurora.branchPattern" }} />);
    await waitFor(() => expect(screen.getByText("{type}/{slug}")).toBeTruthy());
    expect(screen.getByText("Preview")).toBeTruthy();
    expect(screen.getByText(applyTemplate("{type}/{slug}", SAMPLE))).toBeTruthy();
  });

  it("updates the field name on input, which re-reads via the effect", async () => {
    tauri.invoke({
      read_package_field: (a) => ((a.field as string) === "other.field" ? "{key}" : null),
    });
    render(<Controlled initial={{ source: "package-json", field: "aurora.branchPattern" }} />);
    await waitFor(() => expect(screen.getByText("not found in package.json")).toBeTruthy());

    const input = screen.getByDisplayValue("aurora.branchPattern") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "other.field" } });
    await waitFor(() => expect(screen.getByText("{key}")).toBeTruthy());
  });

  it("re-reads the field when 're-read' is clicked", async () => {
    let n = 0;
    tauri.invoke({
      read_package_field: () => {
        n += 1;
        return n === 1 ? null : "{slug}";
      },
    });
    render(<Controlled initial={{ source: "package-json", field: "aurora.branchPattern" }} />);
    await waitFor(() => expect(screen.getByText("not found in package.json")).toBeTruthy());

    fireEvent.click(screen.getByText("re-read"));
    await waitFor(() => expect(screen.getByText("{slug}")).toBeTruthy());
    expect(n).toBe(2);
  });
});

describe("ValidatorEditor", () => {
  it("reports 'no rule found' when detection finds nothing", async () => {
    tauri.invoke({ detect_branch_validator: () => null });
    render(<Controlled initial={{ source: "validator", regex: "", groups: [] }} />);
    expect(screen.queryByText("Detected rule")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText("Detect validator"));
    });
    await waitFor(() => expect(screen.getByText("no validate-branch-name rule found")).toBeTruthy());
    expect(screen.queryByText("Detected rule")).toBeNull();
  });

  it("populates the config and shows the source on successful detection", async () => {
    tauri.invoke({
      detect_branch_validator: () => ({ regex: "^(feat|fix)/.+$", source: "validate-branch-name.sh" }),
      validate_branch_name: () => ({ ok: true, enforced: true }),
    });
    render(<Controlled initial={{ source: "validator", regex: "", groups: [] }} />);
    await act(async () => {
      fireEvent.click(screen.getByText("Detect validator"));
    });
    await waitFor(() => expect(screen.getByText("found in validate-branch-name.sh")).toBeTruthy());
    expect(screen.getByText("Detected rule")).toBeTruthy();
    expect(screen.getByText("^(feat|fix)/.+$")).toBeTruthy();
    // single alternative -> no "Branch shape" selector, but it does have an enum -> Pickers shown
    expect(screen.queryByText("Branch shape")).toBeNull();
    expect(screen.getByText("Pickers")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("✓ valid")).toBeTruthy());
  });

  it("shows an em dash and no valid badge when the regex has no composable groups", async () => {
    render(<Controlled initial={{ source: "validator", regex: "^$", groups: [] }} />);
    expect(screen.getByText("Detected rule")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.queryByText("✓ valid")).toBeNull();
    expect(screen.queryByText("✕ invalid")).toBeNull();
  });

  it("lets you pick between multiple branch shapes and re-derives the preview", async () => {
    tauri.invoke({ validate_branch_name: () => ({ ok: true, enforced: true }) });
    render(<Controlled initial={{ source: "validator", regex: "^(feat|chore)/.+$|^(fix|hotfix)/.+$", groups: [] }} />);
    // Bug -> fix synonym auto-selects the second alternative by default.
    await waitFor(() => expect(screen.getByText("fix/api")).toBeTruthy());
    expect(screen.getByText("Branch shape")).toBeTruthy();

    const featChoice = screen.getByText("feat|chore");
    await act(async () => {
      fireEvent.click(featChoice);
    });
    await waitFor(() => expect(screen.getByText("feat/api")).toBeTruthy());
  });

  it("lets you override an enum picker and updates the composed preview", async () => {
    tauri.invoke({ validate_branch_name: () => ({ ok: false, enforced: true, message: "nope" }) });
    render(<Controlled initial={{ source: "validator", regex: "^(feat|fix)/.+$", groups: [] }} />);
    await waitFor(() => expect(screen.getByText("fix/api")).toBeTruthy());

    const select = screen.getByRole("combobox") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "0" } }); // "feat" is option index 0
    await waitFor(() => expect(screen.getByText("feat/api")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("✕ invalid")).toBeTruthy());
  });

  it("labels branch shapes from their literal text or a positional fallback when there's no enum", async () => {
    tauri.invoke({ validate_branch_name: () => ({ ok: true, enforced: true }) });
    render(
      <Controlled initial={{ source: "validator", regex: "^(feat|fix)/.+$|^chore/.+$|^\\d+$", groups: [] }} />,
    );
    expect(screen.getByText("Branch shape")).toBeTruthy();
    expect(screen.getByText("feat|fix")).toBeTruthy(); // enum-derived label
    expect(screen.getByText("chore")).toBeTruthy(); // literal-derived label
    expect(screen.getByText("shape 3")).toBeTruthy(); // positional fallback (no enum, no literal)
  });
});

describe("AiEditor", () => {
  it("renders the instruction textarea and chain-validator checkbox from the config", () => {
    render(<Controlled initial={{ source: "ai", instruction: "name it well", chainValidator: false }} />);
    expect(screen.getByDisplayValue("name it well")).toBeTruthy();
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  it("updates the instruction on input", () => {
    render(<Controlled initial={{ source: "ai", instruction: "old", chainValidator: true }} />);
    const textarea = screen.getByDisplayValue("old") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "new instruction" } });
    expect(screen.getByDisplayValue("new instruction")).toBeTruthy();
  });

  it("toggles chainValidator via the checkbox", () => {
    render(<Controlled initial={{ source: "ai", instruction: "x", chainValidator: true }} />);
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
  });

  it("runs a preview against Claude and renders the result with reasoning", async () => {
    tauri.invoke({
      claude_text: () => JSON.stringify({ name: "fix/proj-1423-login", reasoning: "matches the instruction" }),
      validate_branch_name: () => ({ ok: true, enforced: true }),
    });
    render(<Controlled initial={{ source: "ai", instruction: "name it", chainValidator: true }} />);
    await act(async () => {
      fireEvent.click(screen.getByText("Preview"));
    });
    await waitFor(() => expect(screen.getByText("fix/proj-1423-login")).toBeTruthy());
    expect(screen.getByText("✓ valid")).toBeTruthy();
    expect(screen.getByText("matches the instruction")).toBeTruthy();
  });

  it("sends the store's configured model through to the backend call", async () => {
    useStore.setState({ settings: { ...DEFAULT_SETTINGS, model: "claude-opus-4-8" } }, false);
    tauri.invoke({ claude_text: () => JSON.stringify({ name: "chore/x", reasoning: "" }) });
    render(<Controlled initial={{ source: "ai", instruction: "name it", chainValidator: false }} />);
    await act(async () => {
      fireEvent.click(screen.getByText("Preview"));
    });
    await waitFor(() => expect(tauri.lastCall("claude_text")).toBeTruthy());
    expect(tauri.lastCall("claude_text")?.args.model).toBe("claude-opus-4-8");
  });

  it("surfaces a no-key explanation when the backend reports no API key", async () => {
    tauri.invoke({
      claude_text: () => {
        throw new Error("no-key");
      },
    });
    render(<Controlled initial={{ source: "ai", instruction: "name it", chainValidator: false }} />);
    await act(async () => {
      fireEvent.click(screen.getByText("Preview"));
    });
    await waitFor(() =>
      expect(screen.getByText("Add an Anthropic API key to use AI branch naming.")).toBeTruthy(),
    );
    expect(screen.getByText("—")).toBeTruthy();
  });
});
