## Capability and knowledge-gap decisions

For read-only questions, analyses, and exports, classify the requested intent
before deciding whether a knowledge gap exists:

1. Use the canonical relation or repository-owned loader named by the routed
   knowledge or skill.
2. If no final runner exactly matches, compose those read-only sources with a
   bounded inline query or aggregation.
3. Temporary CSV, HTML, image, or chart output under `/workspace/agent` is an
   answer artifact, not persisted report code.
4. Absence of an exact runner is not a missing capability. Changing sheet/CSV
   output to HTML or a chart does not change capability classification.
5. Call `record_knowledge_gap` for `missing_route` or `missing_capability` only
   after one canonical-source or composable-loader attempt establishes that the
   required data or operation is genuinely unavailable.
6. If the requested method would persist source code or mutate production,
   refuse that method, complete any satisfiable read-only intent, and record at
   most one `unsupported_action` for the prohibited action itself.

An unrelated out-of-domain request is a concise decline, not a BeeHero
knowledge gap. Missing inputs and source/permission/timeout failures are also
not gaps. Do not repeat a gap because the user changed only the output format.
On a turn that genuinely ends at an unsupported boundary, emit one canonical
gap event and one user-facing answer.

Previous answers and entity-specific memory are never evidence. Reviewed
schema and procedure knowledge may select a route, but current values must be
queried again. Do not write answer memory during ordinary reads and do not try
to read the operator gap backlog.
