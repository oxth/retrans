import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const updates = vi.hoisted(() => ({ checkForUpdate: vi.fn() }));
const prefs = vi.hoisted(() => ({ getAutoCheckUpdates: vi.fn(), setAutoCheckUpdates: vi.fn() }));
vi.mock("../platform/updates", () => updates);
vi.mock("../platform/prefs", () => prefs);

import type { ProjectSession } from "../core/session";
import { useApp } from "./store";
import { UnsavedPrompt } from "./UnsavedPrompt";
import { UpdateBanner, UpdateSettings } from "./UpdateBanner";

const install = vi.fn();
const found = () => ({ version: "1.2.3", install });
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  updates.checkForUpdate.mockReset();
  install.mockReset();
  prefs.getAutoCheckUpdates.mockReset().mockResolvedValue(true);
  prefs.setAutoCheckUpdates.mockReset().mockResolvedValue(undefined);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  warn.mockRestore();
});

describe("UpdateBanner", () => {
  it("shows the banner with the version", async () => {
    updates.checkForUpdate.mockResolvedValue(found());
    render(<UpdateBanner />);
    expect(await screen.findByText("Retrans 1.2.3 is available.")).toBeInTheDocument();
    expect(updates.checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it("hides on Later", async () => {
    updates.checkForUpdate.mockResolvedValue(found());
    render(<UpdateBanner />);
    await userEvent.click(await screen.findByRole("button", { name: "Later" }));
    expect(screen.queryByText("Retrans 1.2.3 is available.")).toBeNull();
  });

  it("installs and shows progress", async () => {
    updates.checkForUpdate.mockResolvedValue(found());
    install.mockImplementation(async (cb: (d: number, t: number) => void) => {
      cb(50, 100);
      await new Promise(() => {});
    });
    render(<UpdateBanner />);
    await userEvent.click(await screen.findByRole("button", { name: "Install and restart" }));
    expect(install).toHaveBeenCalled();
    expect(await screen.findByText("Downloading… 50%")).toBeInTheDocument();
  });

  it("shows a failure message when install fails", async () => {
    updates.checkForUpdate.mockResolvedValue(found());
    install.mockRejectedValue(new Error("boom"));
    render(<UpdateBanner />);
    await userEvent.click(await screen.findByRole("button", { name: "Install and restart" }));
    expect(await screen.findByText("Update failed. Try again later.")).toBeInTheDocument();
  });

  it("renders nothing when the check rejects", async () => {
    updates.checkForUpdate.mockRejectedValue(new Error("offline"));
    const { container } = render(<UpdateBanner />);
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("does not check when auto-check is off", async () => {
    prefs.getAutoCheckUpdates.mockResolvedValue(false);
    const { container } = render(<UpdateBanner />);
    await waitFor(() => expect(prefs.getAutoCheckUpdates).toHaveBeenCalled());
    await Promise.resolve();
    expect(updates.checkForUpdate).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Install and restart with unsaved edits", () => {
  const dirty = { isDirty: () => true } as unknown as ProjectSession;
  const real = useApp.getState().save;
  afterEach(() => useApp.setState({ session: null, closePrompt: null, save: real }));

  async function banner() {
    updates.checkForUpdate.mockResolvedValue(found());
    install.mockResolvedValue(undefined);
    useApp.setState({ session: dirty });
    render(<><UpdateBanner /><UnsavedPrompt /></>);
    await userEvent.click(await screen.findByRole("button", { name: "Install and restart" }));
    return screen.findByRole("dialog", { name: "Unsaved changes" });
  }

  it("asks first; Cancel installs nothing", async () => {
    const d = await banner();
    expect(d).toHaveTextContent("Save them before updating?");
    expect(install).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(install).not.toHaveBeenCalled();
  });

  it("Save installs only after a successful save", async () => {
    const save = vi.fn(async () => false);
    useApp.setState({ save });
    await banner();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(install).not.toHaveBeenCalled();
    save.mockResolvedValue(true);
    await userEvent.click(screen.getByRole("button", { name: "Install and restart" }));
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(install).toHaveBeenCalled());
  });

  it("Discard installs", async () => {
    await banner();
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(install).toHaveBeenCalled());
  });

  it("Settings asks too", async () => {
    updates.checkForUpdate.mockResolvedValue(found());
    useApp.setState({ session: dirty });
    render(<><UpdateSettings /><UnsavedPrompt /></>);
    await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await userEvent.click(await screen.findByRole("button", { name: "Install and restart" }));
    expect(await screen.findByRole("dialog", { name: "Unsaved changes" })).toBeTruthy();
    expect(install).not.toHaveBeenCalled();
  });
});

describe("UpdateSettings", () => {
  it("toggles auto-check", async () => {
    render(<UpdateSettings />);
    const box = await screen.findByRole("checkbox", { name: "Check for updates automatically" });
    await waitFor(() => expect(box).toBeChecked());
    await userEvent.click(box);
    expect(prefs.setAutoCheckUpdates).toHaveBeenCalledWith(false);
  });

  it("reports up to date", async () => {
    updates.checkForUpdate.mockResolvedValue(null);
    render(<UpdateSettings />);
    await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("You're up to date.")).toBeInTheDocument();
  });

  it("reports an available update with install", async () => {
    updates.checkForUpdate.mockResolvedValue(found());
    install.mockResolvedValue(undefined);
    render(<UpdateSettings />);
    await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("Retrans 1.2.3 is available.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Install and restart" }));
    expect(install).toHaveBeenCalled();
  });

  it("reports a failed check", async () => {
    updates.checkForUpdate.mockRejectedValue(new Error("offline"));
    render(<UpdateSettings />);
    await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("Couldn't check for updates.")).toBeInTheDocument();
  });
});
