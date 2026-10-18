import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { PostgresConversationRepository } from "@/lib/repositories/postgres/conversation-repository";
import { PostgresScriptRepository } from "@/lib/repositories/postgres/script-repository";
import { RepositoryError } from "@/lib/repositories/types";

import {
  closeTestDatabase,
  getTestPool,
  pointPoolAtTestDatabase,
  resetDatabase,
} from "../support/fixtures";

/**
 * Conversation storage for the chat route: the assistant's summary is
 * persisted when its change is applied, and the user's message the moment it
 * arrives. Ordering is per conversation, with a stable tiebreak (FR-003, FR-006).
 */

const scripts = new PostgresScriptRepository();
const conversations = new PostgresConversationRepository();

async function newScript(title: string) {
  return scripts.create({ title, styleId: null });
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestDatabase();
});

describe("PostgresConversationRepository", () => {
  it("returns no messages for a fresh conversation", async () => {
    const created = await newScript("Fresh");

    expect(await conversations.getMessages(created.conversation.id)).toEqual([]);
  });

  it("returns only that conversation's messages, in creation order", async () => {
    const first = await newScript("First");
    const second = await newScript("Second");

    await conversations.append(first.conversation.id, "user", "first question");
    await conversations.append(second.conversation.id, "user", "second script question");
    await conversations.append(first.conversation.id, "assistant", "first answer");

    const messages = await conversations.getMessages(first.conversation.id);

    expect(messages.map((message) => message.content)).toEqual([
      "first question",
      "first answer",
    ]);
  });

  it("keeps same-millisecond messages in insertion order, not random-id order", async () => {
    const created = await newScript("Same Instant");
    const instant = "2026-10-17T10:00:00.000Z";
    const contents = ["one", "two", "three"];

    // Each statement is its own transaction, so `now()` alone would already
    // order these. Pinning one timestamp forces the tie, and `seq` is then the
    // only thing left that can order them. The random id would scramble it.
    for (const content of contents) {
      await getTestPool().query(
        `INSERT INTO messages (id, conversation_id, role, content, created_at)
         VALUES (md5($1)::uuid, $2, 'user', $1, $3::timestamptz)`,
        [content, created.conversation.id, instant],
      );
    }

    const returned = await conversations.getMessages(created.conversation.id);

    expect(returned.map((message) => message.createdAt)).toEqual([
      instant,
      instant,
      instant,
    ]);
    expect(returned.map((message) => message.content)).toEqual(contents);
  });

  it("returns the stored message with its id, role and timestamp", async () => {
    const created = await newScript("Shape");

    const message = await conversations.append(
      created.conversation.id,
      "assistant",
      "Done.",
    );

    expect(message).toMatchObject({
      conversationId: created.conversation.id,
      role: "assistant",
      content: "Done.",
    });
    expect(typeof message.id).toBe("string");
    expect(Number.isNaN(Date.parse(message.createdAt))).toBe(false);
  });

  it("finds a script's conversation", async () => {
    const created = await newScript("Owner");

    await expect(conversations.getByScriptId(created.script.id)).resolves.toMatchObject({
      id: created.conversation.id,
      scriptId: created.script.id,
    });
  });

  it("reports an unknown conversation as not found", async () => {
    await expect(
      conversations.append("not-a-uuid", "user", "hello"),
    ).rejects.toMatchObject({ code: "not_found" });

    expect(
      await conversations
        .append("00000000-0000-4000-8000-000000000000", "user", "hello")
        .catch((error: unknown) => error),
    ).toBeInstanceOf(RepositoryError);
  });

  it("reports an unknown script as not found", async () => {
    await expect(
      conversations.getByScriptId("00000000-0000-4000-8000-000000000000"),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("reports reading the messages of an unknown conversation as not found", async () => {
    await expect(
      conversations.getMessages("00000000-0000-4000-8000-000000000000"),
    ).rejects.toMatchObject({ code: "not_found" });

    // A non-UUID cannot name a conversation either, and is not mistaken for one.
    await expect(conversations.getMessages("not-a-uuid")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("passes a database failure through instead of calling it a missing conversation", async () => {
    const created = await newScript("Owner");

    // The next query cannot reach the database at all; that is not "not found".
    await closeTestDatabase();

    try {
      const failure = await conversations
        .append(created.conversation.id, "user", "hello")
        .catch((error: unknown) => error);

      expect(failure).not.toBeInstanceOf(RepositoryError);
    } finally {
      // `beforeEach` re-points the pool; this keeps this file's own teardown honest.
      await pointPoolAtTestDatabase();
    }
  });
});
