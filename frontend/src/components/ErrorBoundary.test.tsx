import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ErrorBoundary from "./ErrorBoundary";

/** A child that fails during render, the way a broken page would. */
function Boom(): never {
  throw new Error("render exploded");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ErrorBoundary (issue #28)", () => {
  it("renders its children while nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>All good</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText("All good")).toBeDefined();
  });

  it("shows the fallback instead of a blank page when a child throws", () => {
    // React logs the caught error too; keep the run's output to the assertions.
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.getByText(/something went wrong/i)).toBeDefined();
    // The fallback offers a way out rather than a dead end.
    expect(screen.getByRole("button", { name: /reload/i })).toBeDefined();
  });

  it("reloads the page when the reload button is pressed", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload },
    });

    try {
      render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      );

      fireEvent.click(screen.getByRole("button", { name: /reload/i }));

      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });
});
