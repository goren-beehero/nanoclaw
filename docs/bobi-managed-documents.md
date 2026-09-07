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

The existing Bobi entry instruction scopes KB discovery to "BeeHero requests".
Extend that existing sentence (do not add a second routing mechanism) to:

> For every BeeHero request, including managed document/pool operations and
> native spreadsheet comments even when the message does not mention BeeHero:

Keep the following existing direct-AGENTS.md lookup and all other routing rules
unchanged. This is an activation prerequisite: otherwise a generic file request
can skip the router entirely. It does not activate pool workflows for ordinary
attachments or one-off conversions; the canonical skill retains that boundary.

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
