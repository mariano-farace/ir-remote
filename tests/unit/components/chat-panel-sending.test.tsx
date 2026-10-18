// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { UIMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatPanel } from "@/components/chat/ChatPanel";

/**
 * What the chat panel does with a request (FR-014a, FR-016).
 *
 * Sending is the one action here that costs a model call, so it happens only
 * from a ready script with text in the prompt; a turn that produced no change
 * says so rather than looking like a silent refusal, and a revision's own
 * summary is shown in the chat while its text goes to the editor.
 */

interface Stub {
  active: { id: string } | null;
  activeConversationId: string | null;
  activeStyleId: string | null;
  restoringConversation: boolean;
  conversationError: { message: string } | null;
  conversation: {
    messages: UIMessage[];
    streaming: boolean;
    error: null;
    producedNoChange: boolean;
    send: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    answerApproval: ReturnType<typeof vi.fn>;
  };
}

const workspace = vi.hoisted(() => ({ current: null as unknown as Stub }));

vi.mock("@/components/workspace/useWorkspace", () => ({
  useWorkspace: () => workspace.current,
}));

function stub(overrides: Partial<Stub> = {}): Stub {
  workspace.current = {
    active: { id: "script-a" },
    activeConversationId: "conv-a",
    activeStyleId: "historical-documentary",
    restoringConversation: false,
    conversationError: null,
    conversation: {
      messages: [],
      streaming: false,
      error: null,
      producedNoChange: false,
      send: vi.fn(async () => undefined),
      stop: vi.fn(),
      answerApproval: vi.fn(),
    },
    ...overrides,
  };

  return workspace.current;
}

function prompt(): HTMLTextAreaElement {
  return screen.getByLabelText(/message/i) as HTMLTextAreaElement;
}

function submitPrompt(): void {
  fireEvent.change(prompt(), { target: { value: "Write about salt roads." } });
  fireEvent.click(screen.getByRole("button", { name: /send/i }));
}

afterEach(() => {
  cleanup();
});

describe("ChatPanel sending a request", () => {
  it("sends the prompt and clears it, so a second send cannot repeat it", () => {
    const stubbed = stub();
    render(<ChatPanel />);

    submitPrompt();

    expect(stubbed.conversation.send).toHaveBeenCalledWith("Write about salt roads.");
    expect(prompt().value).toBe("");
  });

  it("refuses to send while a conversation is still being restored", () => {
    const stubbed = stub({ restoringConversation: true });
    render(<ChatPanel />);

    submitPrompt();

    expect(stubbed.conversation.send).not.toHaveBeenCalled();
    expect(prompt().value).toBe("Write about salt roads.");
  });

  it("refuses to send with no script open", () => {
    const stubbed = stub({ active: null, activeConversationId: null });
    render(<ChatPanel />);

    submitPrompt();

    expect(stubbed.conversation.send).not.toHaveBeenCalled();
  });

  it("refuses to send a blank prompt", () => {
    const stubbed = stub();
    render(<ChatPanel />);

    fireEvent.change(prompt(), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(stubbed.conversation.send).not.toHaveBeenCalled();
  });

  it("says a turn ended without changing the script", () => {
    stub({ conversation: { ...stub().conversation, producedNoChange: true } });
    render(<ChatPanel />);

    expect(screen.getByText(/produced no change/i)).toBeTruthy();
  });

  it("says when the script's conversation could not be restored", () => {
    stub({ conversationError: { message: "The history could not be read." } });
    render(<ChatPanel />);

    expect(screen.getByRole("alert").textContent).toMatch(/could not be restored/i);
  });

  it("shows a revision's summary, never the script body", () => {
    stub({
      conversation: {
        ...stub().conversation,
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            parts: [
              { type: "text", text: "I cut the opening." },
              {
                type: "tool-apply_document_revision",
                toolCallId: "call_1",
                state: "output-available",
                input: {},
                output: { applied: true, summary: "Cut the intro to two sentences." },
              } as UIMessage["parts"][number],
            ],
          },
        ],
      },
    });
    render(<ChatPanel />);

    expect(screen.getByText("I cut the opening.")).toBeTruthy();
    expect(screen.getByText("Cut the intro to two sentences.")).toBeTruthy();
  });
});
