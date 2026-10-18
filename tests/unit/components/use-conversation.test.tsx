// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import type { UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useConversation } from "@/components/workspace/useConversation";

/**
 * The conversation bound to one script (FR-014, FR-014a, FR-022a).
 *
 * The chat SDK is replaced here so its own streaming is out of the way. What
 * is this module's job is classification and gating: which failure the user is
 * told about, whether a prompt may be sent at all, and whether a settled turn
 * actually changed the script.
 */

const chat = vi.hoisted(() => ({
  state: {
    messages: [] as UIMessage[],
    status: "ready" as "ready" | "submitted" | "streaming" | "error",
    error: undefined as unknown,
  },
  sendMessage: vi.fn(async () => undefined),
  stop: vi.fn(),
  addToolApprovalResponse: vi.fn(async () => undefined),
  setMessages: vi.fn(),
  onFinish: null as (() => void) | null,
}));

vi.mock("@ai-sdk/react", () => ({
  useChat: (options: { onFinish?: () => void }) => {
    chat.onFinish = options.onFinish ?? null;

    return {
      ...chat.state,
      sendMessage: chat.sendMessage,
      stop: chat.stop,
      addToolApprovalResponse: chat.addToolApprovalResponse,
      setMessages: chat.setMessages,
    };
  },
}));

const BOUND = { scriptId: "script-a", conversationId: "conv-a", seed: null };

function renderConversation(props: Partial<typeof BOUND> = {}) {
  return renderHook(() => useConversation({ ...BOUND, ...props }));
}

beforeEach(() => {
  chat.state = { messages: [], status: "ready", error: undefined };
  chat.sendMessage.mockClear();
  chat.stop.mockClear();
  chat.addToolApprovalResponse.mockClear();
  chat.onFinish = null;
});

describe("useConversation", () => {
  it("sends the trimmed prompt with only the script and conversation ids (FR-014)", async () => {
    const { result } = renderConversation();

    await act(async () => {
      await result.current.send("  Cut the intro.  ");
    });

    expect(chat.sendMessage).toHaveBeenCalledWith(
      { text: "Cut the intro." },
      { body: { scriptId: "script-a", conversationId: "conv-a" } },
    );
  });

  it("refuses an empty prompt", async () => {
    const { result } = renderConversation();

    await act(async () => {
      await result.current.send("   ");
    });

    expect(chat.sendMessage).not.toHaveBeenCalled();
  });

  it("accepts no second request while one is streaming (FR-014a)", async () => {
    chat.state.status = "streaming";
    const { result } = renderConversation();

    expect(result.current.streaming).toBe(true);

    await act(async () => {
      await result.current.send("A second prompt.");
    });

    expect(chat.sendMessage).not.toHaveBeenCalled();
  });

  it("refuses to send with no script or no conversation bound", async () => {
    const unbound = renderConversation({
      scriptId: null as never,
      conversationId: null as never,
    });

    await act(async () => {
      await unbound.result.current.send("Write about salt roads.");
    });

    expect(chat.sendMessage).not.toHaveBeenCalled();
  });

  it("classifies a time-bound failure as a timeout (FR-022a)", () => {
    chat.state.error = Object.assign(new Error("The upstream request failed"), {
      statusCode: 504,
    });

    const { result } = renderConversation();

    expect(result.current.error).toMatchObject({ cause: "timeout" });
    expect(result.current.error?.message).toMatch(/too long/i);
  });

  it("classifies a timed-out message as a timeout and anything else as upstream", () => {
    chat.state.error = new Error("Request timed out after 60s");
    expect(renderConversation().result.current.error).toMatchObject({ cause: "timeout" });

    const { result } = renderConversation();
    expect(result.current.error).toBeDefined();

    chat.state.error = "the stream ended";
    const { result: second } = renderConversation();

    expect(second.current.error).toMatchObject({ cause: "upstream" });
    expect(second.current.error?.message).toMatch(/could not answer/i);
  });

  it("says a finished turn produced no change when it applied no revision", () => {
    chat.state.messages = [
      { id: "u", role: "user", parts: [{ type: "text", text: "Revise." }] },
      { id: "a", role: "assistant", parts: [{ type: "text", text: "I could not." }] },
    ];

    const { result } = renderConversation();

    act(() => {
      chat.onFinish?.();
    });

    expect(result.current.producedNoChange).toBe(true);
  });

  it("does not call a turn that applied a revision a no-change turn", () => {
    chat.state.messages = [
      {
        id: "a",
        role: "assistant",
        parts: [
          {
            type: "tool-apply_document_revision",
            toolCallId: "call_1",
            state: "output-available",
            input: {},
            output: { applied: true, summary: "Cut the intro." },
          } as UIMessage["parts"][number],
        ],
      },
    ];

    renderConversation();

    act(() => {
      chat.onFinish?.();
    });

    const { result } = renderConversation();

    expect(result.current.producedNoChange).toBe(false);
  });

  it("says nothing about a turn that is still the user's", () => {
    chat.state.messages = [{ id: "u", role: "user", parts: [] }];

    renderConversation();

    act(() => {
      chat.onFinish?.();
    });

    const { result } = renderConversation();

    expect(result.current.producedNoChange).toBe(false);
  });

  it("does not say a turn produced no change when a time bound ended it (FR-022a)", () => {
    // The turn was cut off mid-answer, not left unanswered. Reporting "the
    // assistant produced no change" here would name the wrong cause: the model
    // did produce a change, the request just ran out of time. The timeout alert
    // is the whole story (FR-022, FR-022a).
    chat.state.messages = [
      { id: "u", role: "user", parts: [{ type: "text", text: "Draft the intro." }] },
      {
        id: "a",
        role: "assistant",
        parts: [{ type: "text", text: "I'll create an initial draft exploring…" }],
      },
    ];
    chat.state.error = Object.assign(new Error("The upstream request failed"), {
      statusCode: 504,
    });

    const { result } = renderConversation();

    act(() => {
      chat.onFinish?.();
    });

    expect(result.current.error).toMatchObject({ cause: "timeout" });
    expect(result.current.producedNoChange).toBe(false);
  });

  it("does not say a turn produced no change when the upstream failed (FR-022a)", () => {
    // Same reasoning as the timeout case: an error the user is told about is
    // the cause, so the turn is not also reported as having changed nothing.
    chat.state.messages = [
      { id: "u", role: "user", parts: [{ type: "text", text: "Draft the intro." }] },
      { id: "a", role: "assistant", parts: [{ type: "text", text: "I could not." }] },
    ];
    chat.state.error = "the stream ended";

    const { result } = renderConversation();

    act(() => {
      chat.onFinish?.();
    });

    expect(result.current.error).toMatchObject({ cause: "upstream" });
    expect(result.current.producedNoChange).toBe(false);
  });

  it("passes a stop through and an approval answer straight to the SDK", () => {
    const { result } = renderConversation();

    result.current.stop();
    result.current.answerApproval({ id: "approval_1", approved: true });

    expect(chat.stop).toHaveBeenCalled();
    expect(chat.addToolApprovalResponse).toHaveBeenCalledWith({
      id: "approval_1",
      approved: true,
    });
  });
});
