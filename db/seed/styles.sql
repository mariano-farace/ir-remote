-- styles.sql
--
-- The static style catalogue (FR-007). This file, not the application, is the only
-- write path into `styles` (FR-008). `guidance` is the instruction handed to the model
-- as part of the system prompt and MUST never appear in a conversation (FR-011).
--
-- The seed is idempotent: re-running it updates the catalogue in place without
-- detaching scripts that already reference a style id.
--
-- `display_order` is the catalogue's presentation order. It exists because spec.md's
-- assumptions name "the first style in the catalogue" as the default for a new script,
-- so the order must be a deliberate content decision rather than whatever `created_at`
-- happens to be — every row in one INSERT shares a single transaction timestamp, which
-- would leave the order to the id tiebreak.

INSERT INTO styles (id, name, description, guidance, display_order) VALUES
  (
    'historical-documentary',
    'Historical Documentary',
    'Measured, archival narration that anchors every claim in evidence and period detail.',
    'Write in a measured, archival register suited to historical documentary narration. ' ||
    'Anchor every claim in concrete evidence, dates, names, and period detail, and prefer ' ||
    'the specific artefact over the general summary. Use the present tense for events as ' ||
    'if they unfold before the viewer. Avoid speculation presented as fact; where evidence ' ||
    'is contested, say so plainly. Keep the pacing deliberate, with short sentences at ' ||
    'reveals and longer, flowing sentences when establishing context.',
    10
  ),
  (
    'observational',
    'Observational',
    'Patient, present-tense scene work that lets action and environment carry the meaning.',
    'Write in a patient observational register. Describe what a camera would see and a ' ||
    'microphone would hear rather than what a narrator would assert: present-tense action, ' ||
    'concrete sensory detail, and the texture of the environment. Let scenes breathe and ' ||
    'resist the urge to explain their meaning; trust the viewer to infer it. Minimise ' ||
    'authorial commentary and keep transitions grounded in a physical place or sound.',
    20
  ),
  (
    'investigative',
    'Investigative',
    'Direct, evidence-led exposition that builds a case from documents, testimony and contradiction.',
    'Write in a direct investigative register. Build the narrative as an argument: state ' ||
    'the claim, then the evidence that supports or complicates it. Attribute testimony ' ||
    'explicitly and distinguish what is documented from what is alleged. Use questions ' ||
    'sparingly and only when the answer is close at hand. Keep sentences plain and active, ' ||
    'and foreground the stakes of each revelation for the people involved.',
    30
  )
ON CONFLICT (id) DO UPDATE
  SET name          = EXCLUDED.name,
      description   = EXCLUDED.description,
      guidance      = EXCLUDED.guidance,
      display_order = EXCLUDED.display_order;
