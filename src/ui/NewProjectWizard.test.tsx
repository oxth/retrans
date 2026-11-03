import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pick = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => pick.value) }));
vi.mock("@tauri-apps/api/path", () => ({ documentDir: vi.fn(async () => "/docs"), appDataDir: vi.fn(async () => "/appdata") }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {}, save: async () => {} })),
}));
vi.mock("../platform/watch", () => ({ watchDir: vi.fn(async () => async () => {}) }));

import { MemoryFs } from "../platform/memory-fs";
import { NewProjectWizard } from "./NewProjectWizard";
import { useApp } from "./store";

async function toLocation(name: string) {
  await userEvent.clear(screen.getByLabelText("Project name"));
  if (name) await userEvent.type(screen.getByLabelText("Project name"), name);
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  await userEvent.click(screen.getByRole("radio", { name: /^en\s*English$/ }));
  await userEvent.type(screen.getByLabelText("Search target languages"), "Thai");
  await userEvent.click(screen.getByRole("checkbox", { name: /^th\s*Thai$/ }));
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
}

describe("NewProjectWizard", () => {
  let fs: MemoryFs;
  beforeEach(async () => {
    fs = new MemoryFs();
    await useApp.getState().closeProject();
    useApp.setState({ fs });
    pick.value = null;
  });
  afterEach(cleanup);

  it("defaults the location to <documents>/Retrans/<name>", async () => {
    render(<NewProjectWizard onCancel={() => {}} />);
    await toLocation("My App");
    expect(await screen.findByText("/docs/Retrans/My App")).toBeInTheDocument();
  });

  it("strips characters that are invalid in folder names", async () => {
    render(<NewProjectWizard onCancel={() => {}} />);
    await toLocation(' a/b:c*d ');
    expect(await screen.findByText("/docs/Retrans/abcd")).toBeInTheDocument();
  });

  it("cannot proceed when the folder name ends up empty", async () => {
    render(<NewProjectWizard onCancel={() => {}} />);
    await userEvent.type(screen.getByLabelText("Project name"), '/:*? ');
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("refuses a non-empty folder", async () => {
    fs = new MemoryFs({ "/docs/Retrans/My App/x.txt": "x" });
    useApp.setState({ fs });
    render(<NewProjectWizard onCancel={() => {}} />);
    await toLocation("My App");
    await userEvent.click(await screen.findByRole("button", { name: "Create" }));
    expect(await screen.findByText("Choose an empty folder.")).toBeInTheDocument();
    expect(await fs.exists("/docs/Retrans/My App/.retrans/workspace.json")).toBe(false);
  });

  it.each(["/docs/Retrans/My App/sub/a.txt", "/docs/Retrans/My App/.git/HEAD"])("refuses a folder holding only %s", async (path) => {
    fs = new MemoryFs({ [path]: "x" });
    useApp.setState({ fs });
    render(<NewProjectWizard onCancel={() => {}} />);
    await toLocation("My App");
    await userEvent.click(await screen.findByRole("button", { name: "Create" }));
    expect(await screen.findByText("Choose an empty folder.")).toBeInTheDocument();
    expect(await fs.exists("/docs/Retrans/My App/.retrans/workspace.json")).toBe(false);
  });

  it("hints to choose a folder when the documents folder is unavailable", async () => {
    const { documentDir } = await import("@tauri-apps/api/path");
    vi.mocked(documentDir).mockRejectedValueOnce(new Error("no docs"));
    render(<NewProjectWizard onCancel={() => {}} />);
    await toLocation("My App");
    expect(await screen.findByText("Choose a folder for the project.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("creates and opens a workspace with a common group, and no format files", async () => {
    render(<NewProjectWizard onCancel={() => {}} />);
    await toLocation("My App");
    await userEvent.click(await screen.findByRole("button", { name: "Create" }));
    await vi.waitFor(() => expect(useApp.getState().session).not.toBeNull());
    const s = useApp.getState().session!;
    expect(s.data.locales).toEqual(["en", "th"]);
    expect(s.data.keyOrder).toEqual([]);
    const files = await fs.listFiles("/docs/Retrans/My App", 8);
    expect(files.some((f) => f.endsWith("/th/common.json"))).toBe(true);
    expect(files.some((f) => f.includes("public/locales") || f.includes("project.inlang"))).toBe(false);
  });

  it("Choose... picks another folder", async () => {
    pick.value = "/elsewhere/proj";
    render(<NewProjectWizard onCancel={() => {}} />);
    await toLocation("My App");
    await userEvent.click(screen.getByRole("button", { name: "Choose…" }));
    expect(await screen.findByText("/elsewhere/proj")).toBeInTheDocument();
  });
});
