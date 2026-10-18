import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  ErrorBanner,
  describeFailure,
  type FailureCause,
} from "@/components/chat/ErrorBanner";

/**
 * FR-022a / FR-022: each failure cause has its own message and its own code,
 * so the user can tell "the AI took too long" from "the AI broke" from "you
 * edited the same paragraph". A single generic error would leave every one of
 * those looking like the same incident.
 *
 * The copy is English and written for the user: it says what happened and what
 * to do, and never includes a stack trace, a key, or prompt text.
 */

const CAUSES: readonly FailureCause[] = [
  "timeout",
  "upstream",
  "invalid_output",
  "conflict",
];

afterEach(() => {
  cleanup();
});

describe("describeFailure", () => {
  it("gives every cause a distinct code", () => {
    const codes = CAUSES.map((cause) => describeFailure(cause).code);

    expect(new Set(codes).size).toBe(CAUSES.length);
  });

  it("gives every cause a distinct, actionable message", () => {
    const messages = CAUSES.map((cause) => describeFailure(cause).message);

    expect(new Set(messages).size).toBe(CAUSES.length);

    for (const message of messages) {
      expect(message.length).toBeGreaterThan(20);
      // Actionable: each one tells the user what they can do next.
      expect(message).toMatch(/try|reload|keep|wait|again|unchanged/i);
    }
  });

  it("describes a timeout as a request that took too long, with the script unchanged", () => {
    expect(describeFailure("timeout").message).toMatch(/too long|timed out|time/i);
    expect(describeFailure("timeout").message).toMatch(/unchanged|not changed/i);
  });

  it("describes invalid output as the assistant failing to produce a usable change", () => {
    expect(describeFailure("invalid_output").message).toMatch(
      /could not|invalid|understand|usable/i,
    );
  });

  it("describes a conflict as the document changing underneath the request", () => {
    expect(describeFailure("conflict").message).toMatch(/changed/i);
  });
});

describe("ErrorBanner", () => {
  it("renders the cause's message as an alert", () => {
    render(<ErrorBanner failure={{ cause: "conflict" }} />);

    const alert = screen.getByRole("alert");

    expect(alert.textContent).toBe(describeFailure("conflict").message);
  });

  it("exposes the cause's code for diagnosis, separate from the copy", () => {
    render(<ErrorBanner failure={{ cause: "timeout" }} />);

    expect(screen.getByRole("alert").getAttribute("data-error-code")).toBe(
      describeFailure("timeout").code,
    );
  });

  it("shows a server-provided message when there is one, keeping the server as the authority", () => {
    render(
      <ErrorBanner
        failure={{ cause: "upstream", message: "The AI service is not configured." }}
      />,
    );

    expect(screen.getByRole("alert").textContent).toBe(
      "The AI service is not configured.",
    );
  });

  it("renders nothing when there is no failure", () => {
    render(<ErrorBanner failure={null} />);

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("never renders markup from a failure message (Principle IV)", () => {
    render(
      <ErrorBanner
        failure={{ cause: "invalid_output", message: "<script>alert(1)</script>" }}
      />,
    );

    const alert = screen.getByRole("alert");

    expect(alert.querySelector("script")).toBeNull();
    expect(alert.textContent).toContain("<script>");
  });
});
