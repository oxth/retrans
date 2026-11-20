import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const prefs = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: async (k: string) => prefs.get(k),
    set: async (k: string, v: unknown) => void prefs.set(k, v),
    save: async () => {},
  })),
}));

import { StartupSettings } from "./StartupSettings";

afterEach(cleanup);

describe("Settings → Startup", () => {
  it("defaults to reopening projects and saves the choice", async () => {
    render(<StartupSettings />);
    const select = screen.getByLabelText("When Retrans opens");
    expect(select).toHaveValue("restore");
    await userEvent.selectOptions(select, "Show the start screen");
    await waitFor(() => expect(prefs.get("launchMode")).toBe("start"));
    // The change is confirmed, not silent.
    expect(await screen.findByRole("status")).toHaveTextContent("Saved ✓");
  });

  it("says so when the choice can't be saved", async () => {
    const set = prefs.set.bind(prefs);
    prefs.set = (k: string, v: unknown) => {
      if (k === "launchMode") throw new Error("disk full");
      return set(k, v);
    };
    try {
      render(<StartupSettings />);
      await userEvent.selectOptions(screen.getByLabelText("When Retrans opens"), "Show the start screen");
      expect(await screen.findByRole("status")).toHaveTextContent("Couldn't save: disk full");
    } finally {
      prefs.set = set;
    }
  });

  it("shows the saved choice", async () => {
    prefs.set("launchMode", "start");
    render(<StartupSettings />);
    await waitFor(() => expect(screen.getByLabelText("When Retrans opens")).toHaveValue("start"));
  });
});
