import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RowMenu } from "./RowMenu";

afterEach(cleanup);

function setup() {
  const onRename = vi.fn();
  render(
    <div style={{ transform: "translateY(0px)" }} data-testid="row">
      <RowMenu name="aa" onRename={onRename} onDelete={() => {}} />
    </div>,
  );
  return { onRename };
}

describe("RowMenu", () => {
  it("opens above the rows: the menu is not inside the (transformed) row", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Actions for aa" }));
    const menu = screen.getByRole("menu");
    expect(screen.getByTestId("row")).not.toContainElement(menu);
    expect(menu.style.position).toBe("fixed");
  });

  it("flips above the button when there is no room below it (last row)", () => {
    setup();
    const btn = screen.getByRole("button", { name: "Actions for aa" });
    const rect = (top: number, left: number, width: number, height: number) =>
      ({ top, left, width, height, bottom: top + height, right: left + width, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    btn.getBoundingClientRect = () => rect(window.innerHeight - 30, 100, 20, 20);
    const orig = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return this.getAttribute("role") === "menu"
        ? rect(parseFloat(this.style.top), parseFloat(this.style.left), 150, 80)
        : orig.call(this);
    };
    try {
      fireEvent.click(btn);
      expect(screen.getByRole("menu").style.top).toBe(`${window.innerHeight - 30 - 4 - 80}px`);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = orig;
    }
  });

  it("closes when clicking anywhere else, even if the button never had focus", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Actions for aa" })); // a click that doesn't focus (macOS WebKit)
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on Escape and on scroll", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Actions for aa" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Actions for aa" }));
    fireEvent.scroll(window);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("an item runs its action and closes the menu", async () => {
    const { onRename } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Actions for aa" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(onRename).toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("clicking the button again closes it", async () => {
    setup();
    const btn = screen.getByRole("button", { name: "Actions for aa" });
    fireEvent.pointerDown(btn);
    fireEvent.click(btn);
    fireEvent.pointerDown(btn);
    fireEvent.click(btn);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
