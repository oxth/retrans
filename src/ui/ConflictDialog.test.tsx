import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {}, save: async () => {} })),
}));

import { ConflictDialog } from "./ConflictDialog";
import { type UiConflict, useApp } from "./store";

const text = (t: string) => ({ kind: "text" as const, text: t });
const figma: UiConflict = {
  id: "figma-ALL::ข้อมูลการรับประกัน", locale: "en", origin: "figma",
  mine: text("Guarantee"), theirs: text("Warranty details"), base: text("Warranty info"),
};

afterEach(() => {
  cleanup();
  useApp.setState({ conflicts: [] });
});

describe("ConflictDialog", () => {
  it("figma conflict shows From code / From Figma / Original", () => {
    useApp.setState({ conflicts: [figma] });
    render(<ConflictDialog />);
    const item = screen.getByRole("listitem");
    expect(within(item).getByText("From code")).toBeInTheDocument();
    expect(within(item).getByText("From Figma")).toBeInTheDocument();
    expect(within(item).getByText("Original")).toBeInTheDocument();
    expect(within(item).getByText("Warranty info")).toBeInTheDocument();
  });

  it("Edit… then Use this resolves with the typed text", async () => {
    const resolveConflictWith = vi.fn();
    useApp.setState({ conflicts: [figma], resolveConflictWith });
    render(<ConflictDialog />);
    await userEvent.click(screen.getByRole("button", { name: "Edit…" }));
    const box = screen.getByRole("textbox", { name: "Final version" });
    expect(box).toHaveValue("Warranty details");
    await userEvent.clear(box);
    await userEvent.type(box, "Warranty (final)");
    await userEvent.click(screen.getByRole("button", { name: "Use this" }));
    expect(resolveConflictWith).toHaveBeenCalledWith(figma, "Warranty (final)");
  });

  it("other conflicts keep their labels", () => {
    useApp.setState({ conflicts: [{ id: "common::title", locale: "th", mine: text("a"), theirs: text("b") }] });
    render(<ConflictDialog />);
    expect(screen.getByText("Yours")).toBeInTheDocument();
    expect(screen.getByText("On disk")).toBeInTheDocument();
  });
});
