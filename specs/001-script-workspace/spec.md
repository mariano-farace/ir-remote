# Feature Specification: Script Workspace

**Feature Branch**: `001-script-workspace` (directory name; no git branch was created)

**Created**: 2026-10-17

**Status**: Draft

**Input**: User description from `/speckit-specify` — a web workspace for drafting, generating, and refining scripts for faceless documentary videos with AI assistance, combining a contextual chat panel with a bidirectional live Markdown editor.

## Clarifications

### Session 2026-10-17

- Q: When an AI revision arrives, how should the workspace decide whether it is an edit that replaces part of the script or only adds to it, so that the rest of the script isn't destroyed? → A: Region-addressed edits. The AI names the specific region it is changing and supplies new text for it; everything outside that region is left untouched by construction.
- Q: How should a script get its title in the sidebar? → A: The user MUST supply a title when creating a script; a title is mandatory, never auto-generated, and must be non-blank and unique. Renaming is supported under the same rules.
- Q: When the user clicks another script while an edit is still being saved, what should happen to that unsaved edit? → A: The workspace warns before switching and lets the user wait for the save or discard the pending change.
- Q: A save fails. Should the workspace retry it on its own, and how many times? → A: Three automatic retries with backoff, then report failure and keep the text in the editor.
- Q: The save has failed after retries and the user closes the browser. What protection exists for that unsaved text? → A: A local copy is kept in the browser and the user is offered to restore it when the script is reopened.
- Q: The user sends a second prompt while the first AI response is still streaming. What should happen? → A: Standard chatbot behaviour: the send control becomes a stop control, input stays editable but cannot be sent, and stopping ends the generation.
- Q: If the user presses stop mid-generation, what happens to the document? → A: A change already applied stays applied; no partially written revision is ever persisted.
- Q: A script grows past what the AI can comfortably process. What should the workspace do? → A: Warn the user that context may be lost, then send the request anyway. Nothing is silently truncated.
- Q: The spec says deleting scripts is out of scope but the assumptions say scripts are kept until the user removes them. Which is it? → A: Deletion is part of this feature: confirmed deletion removes the script, its conversation, and its version history.
- Q: There is currently no legitimate way to completely rewrite an existing script. Should users be able to regenerate from scratch? → A: Yes, as an explicit user request. A full-document rewrite requires user confirmation and the previous version stays recoverable.
- Q: How strict should title uniqueness be? → A: Case-insensitive and whitespace-trimmed, maximum 200 characters.
- Q: In what order should the sidebar list scripts? → A: Last modified first.
- Q: The 50,000-character warning and the 30-second AI error bound live in the plan, not the requirements. Should they be requirements? → A: Yes. Both are stated as measurable functional requirements.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Create a script and generate a first draft with AI (Priority: P1)

A writer opens the workspace, clicks "Create new script", and gets a blank document in
the right panel plus a fresh, empty conversation in the center panel. They pick a style
from the sidebar, type a topic into the chat ("The collapse of the Bronze Age trade
networks"), and send it. The AI writes the script, and the text appears in the editor on
the right — not as a chat reply to copy by hand. The writer reads it there immediately.

**Why this priority**: This is the entire product in one loop. Without create → pick
style → prompt → script appears in the editor, there is no tool, only panels. Every
other story makes this loop better; none of them work without it.

**Independent Test**: From an empty workspace, create a script, select a style, send one
topic prompt, and confirm the editor contains non-empty script text that produced no
manual copy-paste. Delivers the core value — a generated first draft in an editable
document.

**Acceptance Scenarios**:

1. **Given** an empty workspace, **When** the user clicks "Create new script", **Then** the
   workspace asks for a title before creating anything, and only once a valid title is
   supplied does a new blank script appear in the sidebar with an empty document and an
   empty chat panel.
2. **Given** the title prompt, **When** the user submits a blank title or a title already
   used by another script, **Then** the script is not created and the user is told which
   rule was broken.
3. **Given** a newly created script with a style selected, **When** the user submits a
   topic prompt, **Then** script text is written into the editor panel, and the chat
   panel shows the user's message and the assistant's response without the full script
   duplicated as a chat message.
4. **Given** a script whose generation is in progress, **When** the user watches the
   editor, **Then** the editor reflects incoming text as it arrives rather than staying
   blank until completion.
5. **Given** a script that has just been generated, **When** the user reloads the
   workspace, **Then** the script text is still present.

---

### User Story 2 - Iterate on an existing script through conversation (Priority: P2)

The same writer rereads the draft and decides the opening is too slow. They type into the
chat: "Cut the intro to two sentences and make the tone colder." The AI revises the
script in place. The writer then manually fixes a date in the editor by typing, and asks
a follow-up. The AI's next revision is based on the corrected date, not on the version it
was looking at before the manual fix.

**Why this priority**: Generation alone produces a first draft, not a usable script. The
value comes from the refine loop, and the loop breaks if the AI edits from a stale view
of the document. This is what makes the tool better than a chat window.

**Independent Test**: Starting from a generated script, issue one revision prompt and
confirm the editor text changed; then type a manual edit, issue a second prompt that
depends on that edit, and confirm the AI's response reflects the manual change. Delivers
conversational refinement over a document whose state both parties agree on.

**Acceptance Scenarios**:

1. **Given** a script with existing text, **When** the user requests a revision in natural
   language, **Then** the editor text is updated to reflect the request.
2. **Given** a script with existing text, **When** the user requests an expansion, a
   reduction, a correction, or a change of tone, **Then** the editor reflects that
   specific kind of change without the rest of the document being discarded.
3. **Given** the user has manually typed an edit into the editor, **When** the user sends
   their next prompt, **Then** the AI's revision accounts for the manually typed text.
4. **Given** the user requests a revision, **When** the AI produces the change, **Then**
   the previous version of the script can be restored without the user having to retype it.

---

### User Story 3 - Reopen a past script with its full conversation (Priority: P2)

A week later the writer opens the workspace and sees every script they have made. They
click one, and the editor fills with that script's text while the chat panel restores the
conversation that produced it. They continue where they left off, and the assistant has
the same context it had then.

**Why this priority**: The workspace is a library of work, not a single scratchpad.
Without reopening, every session starts from zero and the tool cannot support a script
written over several sittings. Ranked alongside iteration because a persisted script
without its conversation loses the reasoning behind the text.

**Independent Test**: Create and generate two scripts, close the workspace, reopen it,
and confirm both appear in the sidebar and that opening either restores exactly its own
text and its own conversation, not the other's. Delivers continuity across sessions.

**Acceptance Scenarios**:

1. **Given** two or more existing scripts, **When** the user opens the workspace, **Then**
   the sidebar lists all of them.
2. **Given** a list of scripts in the sidebar, **When** the user clicks one, **Then** that
   script's text loads into the editor and that script's own conversation loads into the
   chat panel.
3. **Given** a reopened script with prior conversation, **When** the user sends a new
   prompt, **Then** the assistant continues from the restored conversation rather than
   starting fresh.
4. **Given** the user switches from one script to another and back, **Then** neither
   script's text nor conversation is contaminated by the other.

---

### User Story 4 - Assign and change a script's style (Priority: P3)

The writer realizes the documentary they are writing needs a different register. They
change the style selector for the active script from "Historical Documentary" to
"Mystery", and subsequent AI responses follow the new register while the text already
written stays as it is.

**Why this priority**: Style is what separates a generic AI script from one shaped for a
particular kind of documentary, but a script can be produced without ever changing style.
It adds control rather than unlocking the loop.

**Independent Test**: Generate a script under one style, switch the style, and confirm
later responses change in character while the existing text is preserved. Delivers
tone control.

**Acceptance Scenarios**:

1. **Given** the set of predefined styles, **When** the user opens the style selector,
   **Then** all predefined styles are offered and no option to create a new style exists.
2. **Given** a script with no style assigned, **When** the user selects a style, **Then**
   exactly that one style is associated with the script and no other.
3. **Given** a script with a style assigned, **When** the user selects a different style,
   **Then** the association changes and the existing script text is unchanged.
4. **Given** a script with a style assigned, **When** the user sends prompts, **Then**
   every response is shaped by that style, and the style itself is never shown to the user
   as a chat message.

---

### Edge Cases

- **AI returns an empty or whitespace-only result**: the existing script text MUST NOT be
  erased; the user is told the change produced nothing.
- **AI asks to change far more text than the request implies** (its identified region is
  much larger than expected): the user can undo it in one action, and the pre-change
  version is recoverable.
- **AI service is slow, unavailable, or never responds**: the request ends in a visible
  error state within a bounded time; the document is left as it was; the chat does not
  hang indefinitely.
- **AI returns malformed or partially streamed output**: nothing partial is written into
  the saved script; the user sees an error rather than corrupted text.
- **User edits while an AI change is in flight**: no edit is silently lost; either the AI
  change and the manual edit both survive, or the user is shown a conflict and chooses.
- **User edits inside the region an AI revision is about to change**: the revision is
  detected as stale at apply time and is not applied over the new text.
- **User edits a region the AI revision does not touch**: the revision still applies,
  because its target region is still intact.
- **AI proposes a change to a region that no longer exists** (the user deleted it): the
  revision is rejected with an explanation rather than re-creating the deleted text.
- **Script becomes very long**: the workspace still responds and a request does not fail
  silently because the script exceeds what the AI can process — the user is told.
- **Saving fails**: the editor shows that the document is not saved; it does not claim
  success.
- **Script is empty and the user switches away**: switching does not fabricate content or
  discard the empty script without the user's choice.
- **User sends a second prompt while one is streaming**: the input is not sendable; the user
  may stop the first, and stopping persists no partial revision.
- **User deletes the script they are viewing**: the workspace returns to the sidebar list
  with no script selected, and no orphaned content remains.
- **User deletes a script while another is open**: the open script is unaffected.
- **Two tabs hold the same script** (outside the single-user assumption): the second tab's
  save is rejected as stale rather than overwriting, per the stale-write rule.
- **Style is never selected**: the user is prompted to choose one before an AI request that
  needs it, rather than receiving a generic-tone script with no explanation.

## Requirements *(mandatory)*

### Functional Requirements

**Workspace and file management**

- **FR-001**: Users MUST be able to create a new blank script in one action, which creates
  both a new document and a separate, empty conversation belonging to it.
- **FR-001a**: Creating a script MUST require the user to supply a title. A script MUST NOT
  exist without one, and the workspace MUST NOT create an untitled or automatically named
  script on the user's behalf.
- **FR-001b**: A title MUST be non-blank after trimming, MUST NOT exceed 200 characters,
  and MUST be unique among existing scripts when compared case-insensitively on the trimmed
  value. A blank, over-long, or duplicate title MUST be rejected with a message that says
  which rule was broken, and the script MUST NOT be created until it is corrected.
- **FR-001c**: Users MUST be able to rename an existing script. A rename is subject to the
  same rules as creation.
- **FR-001d**: Users MUST be able to delete a script. Deletion MUST require explicit
  confirmation and MUST remove the script's document, its conversation, and its version
  history together. Deletion MUST NOT be silently reversible in part: a partially deleted
  script MUST NOT be observable.
- **FR-002**: The sidebar MUST list every previously created script, ordered by last
  modified, most recent first.
- **FR-003**: Selecting a script in the sidebar MUST load that script's text into the
  editor and that script's conversation into the chat panel, simultaneously.
- **FR-004**: Changes to a script's text MUST be saved automatically, whether the change
  originated from the user or from the AI.
- **FR-005**: The workspace MUST make the save state visible to the user — saved, saving,
  retrying, or failed — and MUST NOT indicate success when a save did not succeed.
- **FR-005a**: A failed save MUST be retried automatically up to three times with
  increasing delay before it is reported as failed.
- **FR-005b**: When a save has failed and the workspace is left, the unsaved text MUST be
  retained locally, and the user MUST be offered the choice to restore it or discard it
  when that script is next opened.
- **FR-005c**: Switching away from a script with an unsaved change MUST warn the user,
  who may wait for the save or discard the pending change.
- **FR-006**: Each script's document and conversation MUST be isolated from every other
  script's.

**Styles**

- **FR-007**: The workspace MUST offer a fixed set of predefined script styles.
- **FR-008**: Users MUST NOT be able to create, edit, or delete styles.
- **FR-009**: A script MUST have at most one style associated with it at any time, and
  selecting a style MUST replace any previously selected one.
- **FR-010**: The style associated with a script MUST shape every AI response for that
  script's conversation.
- **FR-011**: The style's instructions MUST remain invisible in the conversation — the user
  never sees the style prompt as a chat message from either party.

**AI generation and revision**

- **FR-012**: Users MUST be able to request an initial script draft by describing a topic
  in the chat panel.
- **FR-013**: Users MUST be able to request corrections, expansions, reductions, and tone
  changes to the current script using natural language in the chat panel.
- **FR-014**: Each AI request MUST be made with knowledge of the script's current text, so
  that revisions apply to what the user currently has rather than an earlier version.
- **FR-014a**: While a response is streaming, the workspace MUST offer to stop it and MUST
  NOT accept a second concurrent request for that script. The prompt remains editable but
  cannot be sent until the current response ends or is stopped.
- **FR-014b**: Stopping a response MUST end it immediately. Any revision already applied
  stays applied; no partially written revision may be persisted.
- **FR-014c**: When a script exceeds 50 000 characters, the workspace MUST warn the user
  that the AI may lose context, and MUST still send the request if the user proceeds. The
  script MUST NOT be silently truncated.
- **FR-015**: An AI revision MUST apply only the requested change; unrelated parts of the
  script MUST be preserved unless the user asked for them to change.
- **FR-015a**: A *region* is a contiguous span of the script identified by a verbatim quote of its current text (the anchor) or, for a full-document write, the whole document. Every AI revision MUST identify the region of the script it intends to
  change and supply replacement text for that region only. Text outside the identified
  region MUST be left unchanged as a structural consequence, not as an aspiration.
- **FR-015b**: A revision whose identified region no longer matches the text it was based
  on MUST be rejected or re-based before it is applied, and the user MUST be told that the
  document changed underneath the request. It MUST NOT be applied against mismatched text.
- **FR-015c**: A full-document write is permitted in exactly two cases: the first draft
  into an empty document (FR-012), and an explicit user request to regenerate the whole
  script. The second case MUST require user confirmation and MUST leave the previous
  version recoverable under FR-020. A full-document write MUST NOT occur as a side effect
  of a request the user framed as a targeted edit.

**Bidirectional synchronization**

- **FR-016**: When the AI produces or revises a script, the result MUST be written into the
  script document itself, and MUST NOT be delivered as a chat message requiring manual
  copying.
- **FR-017**: Users MUST be able to edit script text directly in the editor.
- **FR-018**: Manually edited text MUST become the basis for the AI's next request from the
  same script, so that the AI's view of the document matches the user's.
- **FR-019**: Concurrent changes from the user and the AI MUST NOT result in silently lost
  edits; when the two conflict, the user MUST be able to resolve it or undo it.
- **FR-020**: Every prior version of a script MUST be recoverable, so that an unwanted AI
  rewrite cannot permanently destroy the user's work.
- **FR-021**: A change that would replace or clear a non-empty script MUST be either
  undoable in one action or require explicit user confirmation before it is saved.

**Failure handling**

- **FR-022**: When the AI service fails, times out, or returns unusable output, the user
  MUST be told what happened, and the script document MUST retain its prior content.
- **FR-022a**: The message the user sees MUST identify the cause well enough to act on —
  a timeout, an upstream failure, output that could not be validated, and a conflicting
  edit MUST be distinguishable from each other.
- **FR-023**: An AI request MUST end, successfully or in a reported error, within 30
  seconds. The workspace MUST NOT remain in a pending state beyond that.

### Key Entities

- **Script**: A documentary script document. Holds its text, a required non-blank unique
  title shown in the sidebar, an optional associated style, timestamps, and a history of
  prior versions. Deleting a Script deletes everything that belongs to it.
- **Local Recovery Copy**: The last text the user had when a save failed, held in the
  browser for that script. Offered back to the user on next open, then discarded whether
  restored or declined.
- **Style**: A predefined writing style that shapes AI responses. Holds a name, a short
  description shown in the selector, and the guidance it gives the AI. Styles are fixed
  content, not user data.
- **Conversation**: The exchange of messages for one script. Belongs to exactly one script;
  holds the ordered messages and is restored when that script is reopened.
- **Message**: A single entry in a conversation. Identifies the speaker (user or assistant),
  the content, and the point in time.
- **Script Version**: A recoverable prior state of a script's text, created whenever the
  text changes, used to restore the document.
- **Pending Revision**: An AI-proposed change awaiting application. Identifies the target
  region, the text that region held when the revision was computed, and the replacement
  text. It is applied only if the target region still holds the expected text.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new user can go from an empty workspace to a first generated script in
  under 3 minutes without instructions or help.
- **SC-002**: 100% of AI-generated or AI-revised changes reach the editor without the user
  copying or pasting any text. A change delivered only as chat text counts as a failure.
- **SC-003**: In a script with an existing conversation, a reopened script restores both its
  text and its conversation correctly in 100% of attempts across repeated sessions.
- **SC-004**: After a manual edit, the very next AI request reflects that edit in 100% of
  cases where the request depends on it.
- **SC-005**: In every failure scenario exercised during acceptance — save failure, browser
  close after a failed save, conflicting edit, rejected revision — the text the user had is
  reachable afterwards either in the document, in version history, or through the local
  recovery offer. Zero scenarios end with unreachable text.
- **SC-006**: When the AI service is unavailable or slow, the user sees a clear error
  within 30 seconds and the script content is unchanged.
- **SC-007**: Users can produce, revise, and save a complete documentary script in a single
  sitting without leaving the workspace.
- **SC-008**: Across at least 10 scripts and repeated open/switch cycles, no script's text
  or conversation appears in another script's panel.
- **SC-009**: When the user requests a change to one part of a script, 100% of the text
  outside that part is identical before and after the AI's revision.
- **SC-010**: When a revision targets text the user has already changed, the user is told
  and no conflicting text is written in 100% of such cases.

## Assumptions

- **Single user, single workspace.** There are no accounts, no sharing, and no
  multi-user collaboration. One person uses the workspace on one device at a time.
- **Styles are shipped content, not user data.** The initial set is defined by the
  product; the exact names and count are a content decision settled before release, not a
  requirement of this feature.
- **The AI is the only source of generated text.** There is no template engine or
  non-AI generation path.
- **Users have a working connection.** The workspace is a web application and the AI
  service is remote; no offline mode is in scope.
- **Scripts are Markdown documents.** The editor presents a visual, formatted view while
  the underlying document is Markdown. No other export format is in scope for this feature.
- **A default style may be applied on creation.** Unless the user chooses otherwise, a
  newly created script takes the first style in the catalogue as its initial value; the
  user can change it at any time. Where no style is assigned, an AI request prompts for one
  before proceeding. A title, unlike style, is never defaulted: it is required from the
  user.
- **Retention**: Scripts and conversations are retained until the user deletes them
  (FR-001d); there is no automatic expiry in this feature.
- **Language**: Interface copy, AI instructions, and all written artifacts are in English,
  as required by the project constitution.
- **Terminology**: A *script* is the entity listed in the sidebar; a *document* is that
  script's text, which is what the AI reads and writes. The two are never used to mean
  different entities, only different aspects of the same one.

## Out of Scope

- Creating, editing, or deleting styles.
- More than one style per script.
- Accounts, authentication, sharing, or collaboration.
- Real-time concurrent editing by multiple people.
- Exporting to formats other than Markdown.
- Running against a model whose tool-calling support is unverified. The workspace fails
  closed and reports the error; it does not adapt to models that cannot produce valid
  revisions.
- Undelete or a trash/restore bin for deleted scripts. Deletion is permanent after
  confirmation (FR-001d).
