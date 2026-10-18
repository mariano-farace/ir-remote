import { describe, expect, it } from "vitest";

import { promptFromChatBody } from "@/lib/http/chat-body";

/**
 * The prompt the server takes from a chat request (contracts/http-api.md).
 *
 * Only the newest user text is read, and only from the two body shapes the
 * contract names. Everything else in the body is client-supplied and must not
 * become part of what the model is told (FR-014).
 */

describe("promptFromChatBody", () => {
  it("reads the message of the contract's minimal body", () => {
    expect(promptFromChatBody({ message: "Write about salt roads." })).toBe(
      "Write about salt roads.",
    );
  });

  it("reads the newest user text from a transport body's typed parts", () => {
    expect(
      promptFromChatBody({
        messages: [
          { role: "user", parts: [{ type: "text", text: "An earlier prompt." }] },
          { role: "assistant", parts: [{ type: "text", text: "An earlier answer." }] },
          {
            role: "user",
            parts: [
              { type: "text", text: "Now make the tone colder." },
              { type: "file", url: "https://example.com/a.txt" },
            ],
          },
        ],
      }),
    ).toBe("Now make the tone colder.");
  });

  it("joins the text parts of the newest user message in order", () => {
    expect(
      promptFromChatBody({
        messages: [
          {
            role: "user",
            parts: [
              { type: "text", text: "Cut the intro " },
              { type: "text", text: "to two sentences." },
            ],
          },
        ],
      }),
    ).toBe("Cut the intro to two sentences.");
  });

  it("reads the content of a message in the older role-and-content shape", () => {
    expect(
      promptFromChatBody({
        messages: [
          { role: "user", content: "Write about the Kodak years." },
          { role: "assistant", content: "Here is a draft." },
        ],
      }),
    ).toBe("Write about the Kodak years.");
  });

  it("has no prompt when the newest user message is blank", () => {
    expect(
      promptFromChatBody({
        messages: [{ role: "user", parts: [{ type: "text", text: "   " }] }],
      }),
    ).toBeUndefined();

    expect(promptFromChatBody({ messages: [{ role: "user", content: "  " }] })).toBe(
      undefined,
    );

    expect(promptFromChatBody({ messages: [{ role: "user" }] })).toBeUndefined();
  });

  it("has no prompt when the conversation holds no user turn", () => {
    expect(
      promptFromChatBody({
        messages: [{ role: "assistant", parts: [{ type: "text", text: "Hello." }] }],
      }),
    ).toBeUndefined();
  });

  it("has no prompt when the body is shaped in no accepted way", () => {
    expect(promptFromChatBody(null)).toBeUndefined();
    expect(promptFromChatBody("a prompt")).toBeUndefined();
    expect(promptFromChatBody({ message: "   " })).toBeUndefined();
    expect(promptFromChatBody({ messages: "not an array" })).toBeUndefined();
    expect(promptFromChatBody({ messages: [null, 7] })).toBeUndefined();
  });
});
