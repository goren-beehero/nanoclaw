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

Use the existing mounted agents-kb tree and its AGENTS.md routes. Expose the two
canonical skill directories through Claude's standard project skill discovery:

```
/workspace/agent/.claude/skills/managed-document-prototype
  -> /workspace/extra/agents-kb/KB/skills/managed-document-prototype
/workspace/agent/.claude/skills/sheets-native-comments
  -> /workspace/extra/agents-kb/KB/skills/sheets-native-comments
```

Create these links in the corresponding host group `.claude/skills/` directory,
using the container paths above as targets. Checkpoint each path's prior state
and verify the checkpoint off-instance first. Reuse an identical link; stop on
any other existing entry rather than overwriting it. Verify targets from inside
a worker, since container paths need not resolve on the host.

These are discovery links, not copied skills or wrappers: descriptions,
instructions and helpers remain owned by the pinned agents-kb tree. Preserve
all other project skills. Leave `.claude-shared/skills/` alone; NanoClaw manages
that separate directory for bundled container skills.

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
source. Also make the canonical skills discoverable as above: a standing request
to read a router is not a substitute for advertising installed capabilities in
the native skill list. Skill descriptions are available at session startup and
the selected skill body is loaded on demand. Validate unrelated behavior and
one-off latency; the managed skill's opt-in boundary remains authoritative.

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
   Add the two native project discovery links above. Verify content hashes,
   resolved skill/helper paths, effective config path,
   read-only KB mount and openpyxl 3.1.5 from the running image. Remove no real
   Drive data during code activation.
5. Validate in fresh Slack threads: ordinary one-offs and follow-ups, explicit
   pool onboarding/create-like/edit/recall, existing-file identity and requester
   access, native comments and duplicate handling. Inspect loaded source paths,
   not just the final answer. Repeat create-like and recall in separate fresh
   threads without naming skills/helpers in the user prompts. Verify each new
   file's card, source lineage and requester access; a correct spreadsheet alone
   is not a managed-workflow pass. Keep prior-business-flow checks in the bundle.
6. Production cutover needs separate approval and its own fresh checks. Preserve
   existing wiring, auth, schedules and session state. Hold on failure; rollback
   requires operator approval and must not overwrite newer Drive content/cards.

To remove discovery after an approved rollback, unlink only the two paths above
after verifying that they still point to the exact recorded targets. Restore any
checkpointed prior entries; keep the canonical KB source and Drive files/cards.
Fresh sessions are required to verify both installation and removal. No running
conversation needs to be deleted or reset for discovery installation.

Run helper contracts with Python/openpyxl available:
```
python -m unittest discover -s KB/skills/managed-document-prototype/tests -p 'test_*.py'
```
