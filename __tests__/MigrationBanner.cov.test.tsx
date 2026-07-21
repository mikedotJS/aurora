// Coverage suite for src/components/MigrationBanner.tsx — the repo-open
// migration-offer banner (managed-server-lifecycle task 6.2).

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { MigrationBanner } from "../src/components/MigrationBanner";
import { useStore } from "../src/state/store";
import { tauri } from "../test/mocks/tauri";
import { defaultAuroraConfig } from "../src/lib/auroraConfig";

beforeEach(() => {
  tauri.reset();
  useStore.setState(
    { migrationBannerRepo: null, dismissedMigrationRepos: [], auroraConfigs: {} },
    false,
  );
});
afterEach(() => cleanup());

describe("MigrationBanner", () => {
  it("renders nothing when no banner is offered", () => {
    const { container } = render(<MigrationBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the repo's short name and the offer copy when a banner is set", () => {
    useStore.setState({ migrationBannerRepo: "/repo/aurora" }, false);
    const { getByText, container } = render(<MigrationBanner />);
    expect(getByText("aurora")).toBeTruthy();
    expect(container.textContent).toContain("aurora.json");
    expect(getByText("Save as aurora.json")).toBeTruthy();
  });

  it("'Save as aurora.json' writes the config, then dismisses the banner (never re-offered this session)", async () => {
    const cfg = { ...defaultAuroraConfig(), scripts: { ...defaultAuroraConfig().scripts, setup: "bun install" } };
    useStore.setState({ migrationBannerRepo: "/repo/aurora", auroraConfigs: { "/repo/aurora": cfg } }, false);
    const { getByText } = render(<MigrationBanner />);
    fireEvent.click(getByText("Save as aurora.json"));
    expect(getByText("Saving…")).toBeTruthy();
    await waitFor(() => expect(useStore.getState().migrationBannerRepo).toBeNull());
    expect(useStore.getState().dismissedMigrationRepos).toEqual(["/repo/aurora"]);
    expect(tauri.lastCall("write_text_file")?.args).toMatchObject({ root: "/repo/aurora", path: "/repo/aurora/aurora.json" });
    expect((tauri.lastCall("write_text_file")?.args.content as string)).toContain("bun install");
  });

  it("a write failure shows an inline error and keeps the banner open", async () => {
    tauri.invoke({
      write_text_file: () => {
        throw new Error("disk full");
      },
    });
    useStore.setState({ migrationBannerRepo: "/repo/aurora" }, false);
    const { getByText, findByText } = render(<MigrationBanner />);
    fireEvent.click(getByText("Save as aurora.json"));
    expect(await findByText(/disk full/)).toBeTruthy();
    expect(useStore.getState().migrationBannerRepo).toBe("/repo/aurora"); // still showing
  });

  it("the × dismisses without saving, and records the repo so it won't be re-offered", () => {
    useStore.setState({ migrationBannerRepo: "/repo/aurora" }, false);
    const { getByTitle } = render(<MigrationBanner />);
    fireEvent.click(getByTitle("dismiss"));
    expect(useStore.getState().migrationBannerRepo).toBeNull();
    expect(useStore.getState().dismissedMigrationRepos).toEqual(["/repo/aurora"]);
    expect(tauri.calls().some((c) => c.cmd === "write_text_file")).toBe(false);
  });
});

describe("store: dismissMigrationBanner", () => {
  it("dedupes — dismissing the same repo twice only records it once", () => {
    useStore.setState({ migrationBannerRepo: "/repo/a", dismissedMigrationRepos: [] }, false);
    useStore.getState().dismissMigrationBanner("/repo/a");
    useStore.getState().dismissMigrationBanner("/repo/a");
    expect(useStore.getState().dismissedMigrationRepos).toEqual(["/repo/a"]);
  });

  it("only clears migrationBannerRepo when it matches the dismissed root", () => {
    useStore.setState({ migrationBannerRepo: "/repo/other", dismissedMigrationRepos: [] }, false);
    useStore.getState().dismissMigrationBanner("/repo/a");
    expect(useStore.getState().migrationBannerRepo).toBe("/repo/other"); // untouched
    expect(useStore.getState().dismissedMigrationRepos).toEqual(["/repo/a"]);
  });
});
