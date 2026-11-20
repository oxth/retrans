import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatusDot } from "./StatusDot";

afterEach(cleanup);

describe("StatusDot", () => {
  it("is announced as an image named by its status, so screen readers say it", () => {
    render(<StatusDot status="reviewed" needsReview={false} machine={false} />);
    expect(screen.getByRole("img", { name: "Status: Reviewed" })).toBeInTheDocument();
  });

  it("names the extra states too", () => {
    render(<StatusDot status="translated" needsReview machine />);
    expect(screen.getByRole("img", { name: /^Status: Not reviewed; .+; machine translated$/ })).toBeInTheDocument();
  });
});
