# Contract: observer mode file and reply format (m7, O1 / O2)

## `config/observe-mode.yaml` (O1)

This is a verbatim JSON → YAML copy of claude-mem 15.2.1 `plugin/modes/code.json`. It starts with:

```yaml
# Adapted from claude-mem 15.2.1 (Apache-2.0, © 2026 Alex Newman): plugin/modes/code.json. Changes: JSON → YAML; no other edits.
```

Keys used by `observe.py` (names as in code.json):
- `name`;
- `observation_types` (9: id, label, description, emoji, work_emoji) and `observation_concepts` (7: id, label, description);
- `prompts.*`: system_identity, observer_role, spatial_awareness, recording_focus, skip_guidance, type_guidance, concept_guidance, field_guidance, format_examples, footer, and the summary_* strings.

Our Legend line and session-start icons come from the types' `emoji`. Loading: `yaml.safe_load` once per job, the same pattern as `graph/extract.load_mode`.

## Prompt layout (O2, from claude-mem `src/sdk/prompts.ts`)

1. `observerInstructions(mode)`: a byte-stable prefix (identity, role, focus, skip guidance, type/concept/field guidance, the `observationSkeleton` XML, examples, footer).
2. Init block: `<user_request>` (stripped + redacted typed prompt) and `<session_start_context>` (this session's last ~20 observation titles, so the model skips what is already recorded).
3. One `<observed_from_primary_session>` block per tool event: tool name, input and result, each shaped to 16,000 chars (60/30 head/tail + `<elided …/>`), with images elided.
4. On the last chunk of the job only: the summary request (`buildSummaryPrompt`) with the last assistant text of the newest turn.

## Reply format (parsed by `observe.parse_reply`)

```xml
<observation>
  <type>discovery</type>
  <title>…</title>
  <subtitle>…</subtitle>
  <facts><fact>…</fact>…</facts>
  <narrative>…</narrative>
  <concepts><concept>how-it-works</concept>…</concepts>
  <files_read><file>src/a.py</file></files_read>
  <files_modified><file>src/b.py</file></files_modified>
</observation>
… (0..n observations)
<summary>
  <request>…</request><investigated>…</investigated><learned>…</learned>
  <completed>…</completed><next_steps>…</next_steps><notes>…</notes>
</summary>
```

Parsing rules:
- `<observation>` and `<summary>` blocks are parsed independently. `<skip_summary reason="…"/>` means no summary.
- A label-wrapped title (`Title: …`) is unwrapped. XML entities are decoded.
- An unknown type drops that observation; unknown concepts are dropped.
- No parsable block at all → one retry with `OBSERVATION_SCHEMA_REMINDER` appended, then the chunk is dropped and counted in `dropped_chunks`.
