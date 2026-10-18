import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { GET as getScript } from "@/app/api/scripts/[id]/route";
import { describeFailure, type FailureCause } from "@/components/chat/ErrorBanner";
import { failureOf } from "@/components/workspace/useConversation";
import { SaveError } from "@/stores/document-store";

import { callRoute, errorCode, errorMessage, jsonRequest } from "../support/api";
import { closeTestDatabase, resetDatabase } from "../support/fixtures";

/**
 * Each failure says what happened, in words the user can act on (FR-022,
 * FR-022a).
 *
 * A timeout, an upstream failure, output that cannot be validated, and an edit
 * that conflicts with a newer one are four different problems. Two promises
 * keep them apart: the server has a distinct code and message for each, and the
 * browser classifies every failure it meets into the banner's own cause — so
 * "you edited this while the assistant was answering" is never shown as "the
 * provider is down".
 */

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestDatabase();
});

describe("the client's classification", () => {
  it("reads the route's timeout sentence as a timeout, with or without its code", () => {
    // The route's time bound reports its failure with this code. Matching on
    // wording alone misreads its sentence — "did not answer within 60
    // seconds" — as an upstream failure.
    const timedOut = failureOf({
      code: "assistant_timeout",
      message:
        "The assistant did not answer within 60 seconds. Your script was not changed.",
    });

    expect(timedOut.cause).toBe("timeout");
    expect(
      // A failure with no code at all: the SDK hands the browser a plain
      // `Error`, so the sentence is all the client has to go on.
      failureOf(new Error("The assistant did not answer within 60 seconds.")).cause,
    ).toBe("timeout");
  });

  it("reads an HTTP timeout status or a timeout-wording error as a timeout", () => {
    expect(failureOf(Object.assign(new Error("Failed"), { statusCode: 504 })).cause).toBe(
      "timeout",
    );
    expect(failureOf(new Error("Request timed out")).cause).toBe("timeout");
  });

  it("reads invalid model output as invalid output, not as an outage", () => {
    expect(
      failureOf({
        code: "invalid_output",
        message: "The assistant's change could not be validated and was not applied.",
      }).cause,
    ).toBe("invalid_output");
  });

  it("reads a conflicting edit as a conflict, not as an outage", () => {
    expect(
      failureOf(new SaveError("stale_write", "The script changed elsewhere.")).cause,
    ).toBe("conflict");
  });

  it("reads anything else as an upstream failure", () => {
    expect(failureOf(new Error("fetch failed")).cause).toBe("upstream");
    expect(failureOf("the stream ended").cause).toBe("upstream");
  });

  it("gives every cause its own code, and every cause its own wording", () => {
    const failures = [
      failureOf({ code: "assistant_timeout", message: "Timed out." }),
      failureOf(new Error("Upstream.")),
      failureOf({ code: "invalid_output", message: "Unusable." }),
      failureOf(new SaveError("stale_write", "Conflict.")),
    ];
    const causes: FailureCause[] = ["timeout", "upstream", "invalid_output", "conflict"];

    expect(failures.map((failure) => failure.cause)).toEqual(causes);
    expect(new Set(failures.map((failure) => failure.code)).size).toBe(4);
    expect(new Set(failures.map((failure) => failure.message)).size).toBe(4);

    // And the copy the user reads is distinct per cause.
    expect(new Set(causes.map((cause) => describeFailure(cause).message)).size).toBe(4);
    expect(new Set(causes.map((cause) => describeFailure(cause).code)).size).toBe(4);
  });
});

describe("the server's error envelopes", () => {
  it("names an unknown script with its own code and message", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    const response = await callRoute(
      (request: Parameters<typeof getScript>[0]) =>
        getScript(request, { params: Promise.resolve({ id }) }),
      jsonRequest(`http://localhost:3000/api/scripts/${id}`, "GET"),
    );

    expect(response.status).toBe(404);
    expect(errorCode(response.json)).toBe("not_found");
    expect(errorMessage(response.json)).toMatch(/script/i);
  });
});
