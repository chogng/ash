---
name: commit-pr
description: Commit Ash changes, publish them to main, or open a pull request when the user requests that outcome.
---

# Commit and Publish

## Choose the requested outcome

- **Commit only:** Create the local commit and stop. A commit request does not imply publishing.
- **Commit and publish to main:** Use this path only when publication to `main` is authorized.
- **Pull request:** Use this path only when a PR is requested. Open it as a draft unless the user specifies otherwise.

If the repository or publication target is unclear, ask before committing or publishing.

## Prepare the exact change

1. Before staging, inspect `git status --short --branch`, `git remote -v`, `git diff`, `git diff --cached`, and relevant untracked files. Check for an existing merge or rebase before starting another operation.
2. If the index includes unrelated or uncertain work, stop and ask; do not unstage, stash, reset, or overwrite it. If one file mixes task and unrelated edits, stage only the task hunks, or stop when they cannot be separated.
3. Complete any missing checks required by [Testing Guidelines](../../../.github/instructions/testing.instructions.md) before staging.
4. Stage explicit paths or reviewed hunks. Do not use `git add -A`, `git add .`, or `git commit -a` to collect a dirty tree. Review `git diff --cached` and `git diff --cached --check` immediately before committing; the entire staged diff must belong to this task.

## Write and verify the commit

Fill [the shared change template](../../../.github/pull_request_template.md) without leaving comments or placeholders. Keep one logical change per commit; do not split by file type.

Commit messages and PR titles and descriptions must focus exclusively on Ash and never mention other projects.

After committing, inspect the diff and SHA with `git show` and recheck `git status`. Do not bypass a failed hook. Verify that the commit excludes unrelated work and that unrelated working-tree changes remain intact. Stop here for commit-only requests.

## Publish to main

1. Verify the remote and authorized `main` target. Inspect every local commit that would be published; stop if the range contains unrelated or uncertain commits. Do not publish from a detached HEAD or switch branches over unrelated work.
2. Fetch the selected remote's `main` immediately before publishing. If it advanced, rebase only task-owned, unpublished commits onto that fetched head. Do not rewrite published or unrelated history. If the operation requires cleaning unrelated changes, stop instead of auto-stashing them.
3. Stop on ambiguous or out-of-scope conflicts. Review the integrated diff and revalidate changes introduced by rebasing or conflict resolution. Capture the final commit SHA after any rewrite.
4. Push serially with an explicit non-force target, for example `git push <remote> HEAD:refs/heads/main`. Never force-push `main`. If a concurrent update rejects the push, perform one more fetch, safe rebase, and affected validation, then retry the normal push once. If it is rejected again or integration is unsafe, report the blocker rather than looping or overwriting remote work.
5. Read the remote ref after pushing. Verify that it equals the final commit SHA, or fetch and prove that SHA is an ancestor of the newer remote head if another commit arrived.

## Open the requested PR

1. Verify the repository, head branch, remote, and base branch from the request and repository configuration; do not assume a universal base such as `master`. Inspect the complete head-to-base diff and all commits to be published for task ownership.
2. Check for an existing open PR for that head and base. Report the existing PR instead of creating a duplicate. Do not edit its title, description, draft state, or unrelated content without authorization.
3. Push the authorized head branch without force and verify the remote commit. Stop on unexpected remote divergence. Fill the shared change template, then create the requested draft PR. Do not merge or enable auto-merge without a request.

## Report the observed result

Report the commit SHA, branch, publication or PR link, and checks run. Inspect CI for the published SHA; distinguish pending, failed, skipped, absent, and passed checks.
