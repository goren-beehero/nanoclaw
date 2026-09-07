# Bobi managed-document capability deployment

Source ownership:

- Bee-Hero/agents-kb owns `KB/skills/managed-document-prototype/` (including
  helper scripts and tests), `KB/skills/sheets-native-comments/`, and their narrow
  routes in the existing AGENTS.md router.
- NanoClaw owns the Python image dependency `openpyxl==3.1.5`. No host dispatch,
  attachment, scheduler, connector or session behavior change is required.
- Runtime configuration owns the Drive root selection. Drive owns documents,
  pool membership and cards. Do not commit auth, real pool IDs, private
  CLAUDE.local.md content, transcripts or validation prompts to either repo.

The historical managed-document-prototype name is retained to avoid an unrelated
rename. It is not a second implementation.

## Scoped activation

Use the existing mounted agents-kb tree and its normal AGENTS.md routing. Skills
and helpers resolve below `/workspace/extra/agents-kb/KB/skills/`, like existing
capabilities. Do not add private wrappers, symlinks or special skill selections.
The shared-router additions are the two intent-specific skill routes.

Reference the canonical router in `groups/<agent>/instructions.prepend.md`, the
supported standing-instruction source used by `readGroupPersona` and copied
into the composed persona fragment at spawn. Add this standing instruction:

```
Before answering the first request in a fresh session, read /workspace/extra/agents-kb/AGENTS.md and follow its direct routes. Recheck those routes when the user changes intent, including from a one-off file request to a pool operation. Ordinary files remain ad hoc unless the user requests a managed workflow.
```

Do not use legacy `CLAUDE.local.md` for this activation and do not edit generated
`CLAUDE.md` or `.claude-fragments/persona.md` directly. Verify this instruction in the
fresh worker's composed persona fragment. Preserve all other standing text.
Remove an experimental router import from legacy `CLAUDE.local.md` if present;
do not copy that legacy file's whole contents into standing instructions.

Keep the existing BeeHero routing text unchanged. Do not duplicate skill routes
or keep the experimental expanded entry sentences. A conditional instruction to
look up the router proved unreliable for generic file requests and transitions
from one-off work into an explicit pool operation. A nested router import also
failed that live transition. Use the explicit lookup in the supported standing
source, not a new per-feature selector. Only the router is read initially;
the selected skill is read on demand. This adds one router read and its context
per fresh session; validate unrelated behavior and one-off latency.

Back up and remove only the obsolete managed-document section from Bobi's private
instructions and the two private prototype skill copies. Preserve every other
instruction and skill. Let existing sessions finish before replacing these paths;
validate using fresh sessions so old loaded instructions are not mistaken for
the new KB route. No scheduler, container-config or core skill-sync change is needed.

Configure `/workspace/agent/.config/managed-documents.json` with the approved
`root_folder_id` and optional `root_folder_name`. Helpers also accept `--config`.
This is a root locator, not a local registry or document store. Existing working
pools can be adopted without cloning them. Test must not implicitly create a new
root or copy Production state when configuration is absent.

## Deployment verification

1. Record exact NanoClaw and agents-kb commit IDs and changed-path manifests.
   Validate helper tests and the image dependency before installing.
2. Capture affected skill directories/symlinks, routing section and configuration;
   verify the checkpoint off-instance before replacements. Inventory/backup old
   private overrides before moving them out of the discoverable skills directory.
3. Install the two skills from the pinned KB commit into the mounted tree. Do not
   replace the rest of the KB or transfer evaluator artifacts. The tests are
   prompt-free unit contracts; live prompts/results stay outside mounted repos.
4. Install the two scoped AGENTS.md routes and preserve the approved root config.
   Verify content hashes, resolved skill/helper paths, effective config path,
   read-only KB mount and openpyxl 3.1.5 from the running image. Remove no real
   Drive data during code activation.
5. Validate in fresh Slack threads: ordinary one-offs and follow-ups, explicit
   pool onboarding/create-like/edit/recall, existing-file identity and requester
   access, native comments and duplicate handling. Inspect loaded source paths,
   not just the final answer. Keep prior-business-flow checks in the rollout bundle.
6. Production cutover needs separate approval and its own fresh checks. Preserve
   existing wiring, auth, schedules and session state. Hold on failure; rollback
   requires operator approval and must not overwrite newer Drive content/cards.

Run helper contracts with Python/openpyxl available:
```
python -m unittest discover -s KB/skills/managed-document-prototype/tests -p 'test_*.py'
```
