---
name: commit-pr
description: Commit Ash changes, publish them to main, or open a pull request when requested.
---

# Commit and Publish

## Local commit

1. Review the working-tree and staged diffs. Stage only the requested changes. Use `git add -p -- <path>` for mixed files and verify both `git diff --cached` and `git diff`. If unrelated changes are already staged or cannot be separated safely, ask before proceeding.
2. Run any missing [tests required by the repository](../../../.github/instructions/testing.instructions.md) and run `just commit-check` on the staged changes. If a check fails, fix what belongs to the commit and rerun it.
3. Use the [shared change template](../../../.github/pull_request_template.md). Commit, verify the result with `git show` and `git status`, and report the SHA and checks. A request to commit authorizes a local commit.

## Publish or open a PR

- Get explicit authorization for the destination. Fetch its base branch, verify the commits in scope, and run `just commit-check --publish <base-ref>` from a clean checkout of the exact commit. Add `--full` when formatter configuration changes.
- If the base advances, rebase only unpublished commits owned by this task and rerun the checks. Stop if integration would overwrite unrelated work. Push to the explicit remote and branch without force, then verify the remote revision.
- For a PR, check for an existing one first. Open a draft unless requested otherwise. Report the link and observed CI status.
