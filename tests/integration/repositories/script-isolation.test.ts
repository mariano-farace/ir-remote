import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { ScriptId } from "@/lib/domain/types";
import { PostgresConversationRepository } from "@/lib/repositories/postgres/conversation-repository";
import { PostgresRevisionRepository } from "@/lib/repositories/postgres/revision-repository";
import { PostgresScriptRepository } from "@/lib/repositories/postgres/script-repository";
import { RepositoryError } from "@/lib/repositories/types";

import { closeTestDatabase, resetDatabase } from "../support/fixtures";

/**
 * FR-006: one script's content, messages, and revisions are never returned for
 * another. The scripts here are created and read in an interleaved,
 * repeated cycle — the pattern that catches state that leaked between calls
 * (a cached row, a connection holding a stale transaction, an id used from the
 * previous request) — and every accessor is checked against every script.
 */

const scripts = new PostgresScriptRepository();
const conversations = new PostgresConversationRepository();
const revisions = new PostgresRevisionRepository();

interface Fixture {
  readonly name: string;
  readonly id: ScriptId;
  readonly conversationId: string;
  readonly text: string;
  readonly marker: string;
}

let counter = 0;

/** A script whose content, messages and revisions all carry the same marker. */
async function make(name: string): Promise<Fixture> {
  counter += 1;
  const marker = `MARKER-${name}-${counter}`;
  const text = `# ${name}\n\nThe ${marker} paragraph.\n`;
  const created = await scripts.create({
    title: `${name} ${counter}`,
    styleId: null,
    content: text,
  });

  await conversations.append(created.conversation.id, "user", `Write about ${marker}.`);
  await conversations.append(
    created.conversation.id,
    "assistant",
    `Wrote the ${marker} draft.`,
  );

  return {
    name,
    id: created.script.id,
    conversationId: created.conversation.id,
    text,
    marker,
  };
}

/** Edits a script's content, leaving its marker in the new text. */
async function edit(fixture: Fixture, suffix: string): Promise<void> {
  const current = await scripts.get(fixture.id);

  await scripts.updateContent(
    fixture.id,
    `${fixture.text}Edited ${suffix} (${fixture.marker}).\n`,
    current.updatedAt,
    "user",
  );
}

function otherMarkers(fixtures: readonly Fixture[], own: Fixture): string[] {
  return fixtures.filter((fixture) => fixture !== own).map((fixture) => fixture.marker);
}

async function conversationText(fixture: Fixture): Promise<string> {
  const messages = await conversations.getMessages(fixture.conversationId);

  return messages.map((message) => message.content).join("\n");
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestDatabase();
});

describe("scripts do not see each other's data (FR-006)", () => {
  it("returns each script's own document, never another's, across interleaved reads", async () => {
    const fixtures = [await make("Alpha"), await make("Beta"), await make("Gamma")];

    // Read them in an order that is not their creation order, twice.
    const order = [2, 0, 2, 1, 0, 1];

    for (const index of order) {
      const fixture = fixtures[index];
      const script = await scripts.get(fixture.id);

      expect(script.content).toContain(fixture.marker);

      for (const marker of otherMarkers(fixtures, fixture)) {
        expect(script.content).not.toContain(marker);
      }
    }
  });

  it("returns each conversation's own messages, never another's", async () => {
    const fixtures = [await make("Alpha"), await make("Beta")];

    for (const fixture of fixtures) {
      const text = await conversationText(fixture);

      expect(text).toContain(fixture.marker);

      for (const marker of otherMarkers(fixtures, fixture)) {
        expect(text).not.toContain(marker);
      }
    }

    // The conversation id a script owns is its own.
    const owned = await conversations.getByScriptId(fixtures[1].id);

    expect(owned.id).toBe(fixtures[1].conversationId);
  });

  it("returns each script's own revisions, never another's", async () => {
    const fixtures = [await make("Alpha"), await make("Beta")];

    await edit(fixtures[0], "first");
    await edit(fixtures[1], "first");
    await edit(fixtures[0], "second");

    const alpha = await revisions.list(fixtures[0].id);
    const beta = await revisions.list(fixtures[1].id);

    expect(alpha.length).toBeGreaterThan(0);
    expect(beta.length).toBeGreaterThan(0);

    for (const version of alpha) {
      expect(version.preview).not.toContain(fixtures[1].marker);
    }

    for (const version of beta) {
      expect(version.preview).not.toContain(fixtures[0].marker);
    }

    // Alpha has two versions, beta one: the counts are each script's own.
    expect(alpha).toHaveLength(2);
    expect(beta).toHaveLength(1);
  });

  it("refuses to restore a revision through another script's id", async () => {
    const [alpha, beta] = [await make("Alpha"), await make("Beta")];

    await edit(alpha, "first");

    const [alphaVersion] = await revisions.list(alpha.id);
    const betaBefore = await scripts.get(beta.id);

    // The version exists, but not as one of beta's: nothing of alpha may come
    // back through beta's id.
    await expect(revisions.restore(beta.id, alphaVersion.id)).rejects.toMatchObject({
      code: "not_found",
    } satisfies Partial<RepositoryError>);

    const betaAfter = await scripts.get(beta.id);

    expect(betaAfter.content).toBe(betaBefore.content);
    expect(betaAfter.content).not.toContain(alpha.marker);
  });

  it("keeps the data separate after repeated create/get cycles", async () => {
    const roundOne = [await make("First"), await make("Second")];
    const roundTwo = [await make("Third"), await make("Fourth")];

    for (let cycle = 0; cycle < 3; cycle++) {
      for (const fixture of [...roundOne, ...roundTwo]) {
        const script = await scripts.get(fixture.id);
        const messages = await conversationText(fixture);

        expect(script.content).toContain(fixture.marker);
        expect(messages).toContain(fixture.marker);

        for (const marker of otherMarkers([...roundOne, ...roundTwo], fixture)) {
          expect(script.content).not.toContain(marker);
          expect(messages).not.toContain(marker);
        }
      }
    }
  });

  it("leaves other scripts untouched when one is edited, renamed, or deleted", async () => {
    const fixtures = [await make("Alpha"), await make("Beta"), await make("Gamma")];
    const before = await Promise.all(fixtures.map((fixture) => scripts.get(fixture.id)));

    await edit(fixtures[0], "edited");
    await scripts.rename(fixtures[1].id, "Renamed beta");
    await scripts.delete(fixtures[2].id);

    for (const fixture of [fixtures[0], fixtures[1]]) {
      const script = await scripts.get(fixture.id);
      const previous = before[fixtures.indexOf(fixture)];

      expect(script.content).toContain(fixture.marker);
      expect(script.content.startsWith(previous.content)).toBe(true);

      for (const marker of otherMarkers(fixtures, fixture)) {
        expect(script.content).not.toContain(marker);
      }
    }

    await expect(scripts.get(fixtures[2].id)).rejects.toMatchObject({
      code: "not_found",
    });

    // Deleting one script takes only its own conversation and revisions.
    await expect(conversations.getByScriptId(fixtures[2].id)).rejects.toMatchObject({
      code: "not_found",
    });

    expect((await revisions.list(fixtures[0].id)).length).toBeGreaterThan(0);
    expect(await conversationText(fixtures[1])).toContain(fixtures[1].marker);
  });

  it("lists every script exactly once, in UTC order, with no other script's data", async () => {
    const fixtures = [await make("Alpha"), await make("Beta"), await make("Gamma")];
    const listed = await scripts.list();

    expect(listed.map((summary) => summary.id).sort()).toEqual(
      fixtures.map((fixture) => fixture.id).sort(),
    );
    expect(new Set(listed.map((summary) => summary.id)).size).toBe(listed.length);
  });
});
