# Bobi Mounted Repository Releases

This runbook covers releasing reviewed Git repository content into Bobi's
read-only additional mounts, such as `/opt/repos/agents-kb`. It is an operator
procedure for the Bobi fork, not business knowledge for an agent-readable KB.

It does not cover updating NanoClaw itself. Use the supported NanoClaw upgrade
flow for application releases.

## Decision

Treat each mounted repository as an immutable, content-addressed release:

- Build the release from an explicitly approved Git commit.
- Install tracked content without `.git` into a staged sibling directory.
- Verify a complete path, type, hash, and mode manifest before activation.
- Activate by changing which directory occupies the stable host path; never
  mutate the active directory in place.
- Retain the prior directory as the rollback release until acceptance finishes.
- Do not restart NanoClaw or existing session containers unless that separate
  action was explicitly approved.

This preserves a stable mount path while making the source and rollback state
auditable. It also prevents stale generated files from surviving an overlay
copy.

## Container visibility invariant

A container bind-mounted before activation can remain attached to the old
directory even after the stable host path points to the new release. Containers
created afterward resolve the stable path to the new directory.

Therefore:

- Existing sessions are not proof that the new release is active.
- A fresh container and fresh conversation are required for acceptance.
- Do not claim every running session was upgraded by changing the host path.
- If every active session must switch immediately, treat container replacement
  as a separate production change with its own approval and rollback plan.

## Preconditions

Before writing to the host, record:

1. The exact Bobi host and NanoClaw release being operated.
2. The mounted repository's canonical origin, approved ref, and commit.
3. The stable host path and its current path, type, hash, and mode manifest.
4. The mounted root directory's mode, owner, and group, plus every host and
   container runtime identity that must traverse it. Git tree metadata and a
   descendant-file manifest do not capture this complete access contract.
5. Active containers, workers, and processing claims that could overlap the
   activation window.
6. A timestamped backup of the active tree stored outside the active repository
   paths, plus a verified off-instance copy.
7. Explicit approval for the repository activation. Approval to update mounted
   content does not imply approval to restart NanoClaw or terminate containers.

Stop if the source commit, active tree, backup, or production authority is
ambiguous.

## Build and stage

1. Fetch the approved canonical ref without changing the operator worktree.
2. Resolve and record the exact commit.
3. Produce an archive from that commit's tracked files. Do not include `.git`,
   local caches, generated reports, evaluator artifacts, secrets, or untracked
   operator files.
4. Extract into a uniquely named staged sibling of the stable host path.
5. Generate the expected manifest from the approved commit and the actual
   manifest from the staged directory.
6. Require the manifests to match exactly. Classify every added, removed,
   changed, or mode-changed path before activation.
7. Explicitly apply the approved root mode, owner, and group to the staged
   directory. Staging-directory tools commonly create an owner-only root; do
   not infer root traversability from readable descendant files.
8. As the host runtime identity, traverse the staged root and read the routed
   entrypoint while confirming its expected hash.
9. Run prompt-free repository contract tests against the staged release when
   the repository provides them.

Do not use `git pull`, in-place `rsync`, or an overlay copy against the active
directory.

## Activate

Use one of these activation methods and describe it accurately in the operator
record:

- **Atomic exchange:** use an approved filesystem primitive that exchanges the
  staged and active directories in one atomic operation.
- **Staged rename:** temporarily quiesce new container creation, rename the
  active directory to its rollback path, rename the staged directory to the
  stable path, verify the stable path, and release the gate. A two-rename
  procedure is not an atomic exchange.

After activation:

1. Verify that the stable host path has the approved manifest and the approved
   root mode, owner, and group.
2. As the host runtime identity, traverse the stable root and read the routed
   entrypoint while confirming its expected hash. A privileged hash check does
   not prove that the runtime can read the mount.
3. Verify the rollback path still has the previous manifest and its recorded
   root mode, owner, and group.
4. Confirm NanoClaw's configured additional mount still names the stable path
   and remains read-only.
5. Confirm no unrelated runtime state, database, durable memory, or repository
   was changed.

## Acceptance

Acceptance requires evidence from a container created after activation:

1. As the container runtime identity, traverse the mounted root and read the
   routed entrypoint while confirming its expected hash. A declared mount,
   healthy service, successful extraction, or privileged host read is not
   equivalent evidence.
2. Start a fresh `#bobi-testing` parent after the fresh container is available.
3. Exercise the changed routing or behavior with a representative natural
   prompt.
4. Verify the visible answer, delivery, relevant route or tool trajectory,
   latency, and absence of mounted-repository writes.
5. Keep an outage, timeout, missing reply, or mixed manifest inconclusive or
   failed as appropriate; do not promote it to a pass from host-side evidence.

An acknowledgement, an old thread, or a host manifest alone is insufficient.

## Rollback

Rollback restores the retained prior directory to the stable path using the
same activation discipline:

1. Record current containers and processing claims.
2. Quiesce new container creation when the rollback uses staged renames.
3. Move or exchange the current release out of the stable path and restore the
   retained prior release.
4. Verify the restored host manifest and read-only mount configuration.
5. Restore and verify the retained root's recorded mode, owner, and group.
6. Require an actual routed-entrypoint read from the host runtime identity and
   every active worker that can serve traffic. Workers intentionally pinned to
   different releases must each read the expected entrypoint for their mounted
   release.
7. Validate from a fresh container and fresh conversation.

If any required identity cannot traverse the root or read the entrypoint, the
rollback is incomplete even when hashes, extraction, mounts, and service health
look correct. Stop and recover before declaring success.

Do not delete either release or the off-instance backup until the rollout is
accepted and its rollback window has closed.

## Required operator record

Keep the deployment record outside agent-readable mounted repositories. Include:

- Host and NanoClaw release
- Source origin, ref, and commit
- Expected, staged, active, and rollback manifest fingerprints
- Stable, staged, active, and rollback root mode/owner/group evidence
- Backup locations and checksums
- Activation method and gate evidence
- Pre-existing container/session visibility
- Host-runtime and per-serving-worker routed-entrypoint read evidence
- Fresh-container and fresh-thread validation evidence
- Final accept, rollback, or unresolved decision

Never include credentials, raw private transcripts, customer data, or evaluator
held-outs in the record.
