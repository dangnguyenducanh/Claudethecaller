# Contract: context mode file (`config/context-mode.yaml`, T04)

Shaped after claude-mem's `modes/code.json` (types, concepts → our relations, field rules, skip guidance, output format). The file's sha256 is part of every `extract:` cache key, so editing it re-extracts.

```yaml
version: 1
model: haiku
max_chunk_chars: 6000        # one heading section; longer sections split at paragraph breaks
node_types: [decision, constraint, requirement]     # what Claude may add; stories/tasks/FRs come from the parser only
relations: [constrains, refines, needs, mentions]
prompts:
  system: >-
    You extract project knowledge for coding agents from one section of a project document. ...
  field_rules: >-
    title: ≤ 12 words. text: standalone facts, no pronouns, keep names of files, functions, values. ...
  skip: >-
    If the section adds nothing beyond the known nodes listed, reply exactly <skip reason="..."/>.
  output_format: |
    <node type="decision|constraint|requirement" slug="short-slug" line="N"><title>…</title><text>…</text></node>
    <edge from="<known id or slug>" to="<known id or slug>" relation="constrains|refines|needs|mentions"/>
```

Each call's prompt = `system` + `field_rules` + `skip` + `output_format` + "Known nodes in this file:" (the parser's ids + labels for that file) + the chunk text with line numbers. Output is parsed with `xml.etree.ElementTree` after wrapping in `<r>…</r>`; unknown types/relations and edges to unknown ids are dropped; a chunk whose output fails to parse is logged and skipped. Nodes get origin `claude`, confidence of their edges `INFERRED`.
