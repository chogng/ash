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
3. Format only task-owned files with `just fmt <paths...>` before staging. Never use a repository-wide write or collect all dirty paths for automatic fixes. When a file mixes task and unrelated edits, review formatter output and preserve unrelated hunks.
4. Complete any missing checks required by [Testing Guidelines](../../../.github/instructions/testing.instructions.md) before staging.
5. Stage explicit paths or reviewed hunks. Do not use `git add -A`, `git add .`, or `git commit -a` to collect a dirty tree. Review `git diff --cached` immediately before committing; the entire staged diff must belong to this task.
6. Run `just commit-check <base-ref>` once after staging, using the destination branch as `<base-ref>` (normally `origin/main`). This [repository commit gate](../../../AGENTS.md#development-workflow) already runs incremental formatting and both working-tree and staged whitespace checks; do not run a separate `just fmt-check --changed <base-ref>` before it. Add `--full` when formatter configuration changes. Attribute failures to the exact staged change:
   - For failures in staged files or caused by the staged change, fix only task-owned content, restage, and rerun the affected checks and gate. If attribution is unclear, investigate before committing.
   - When failures are proven to affect only files outside the commit and are not caused by the staged change, continue the requested local commit without asking for confirmation. Report those failures without modifying, staging, or waiting for unrelated work. Run any required checks for the staged change that an early gate failure prevented from executing; never report the failed gate as passed. For example, an unstaged voice file's formatting error does not block a settings-only commit.
   Further edits or staging invalidate the checked result. This exception authorizes the local commit only; publication still requires the passing gate described below.
7. For immediate publication after committing, reuse the passing gate only when the commit tree exactly matches the checked staged tree, working-tree contents and formatter inputs/tools remain unchanged, and fetching leaves the comparison ref unchanged. Otherwise rerun it; publication of existing commits without a matching verified result requires the gate.

## Write and verify the commit

Fill [the shared change template](../../../.github/pull_request_template.md) without leaving comments or placeholders. Keep one logical change per commit; do not split by file type.

Commit messages and PR titles and descriptions must focus exclusively on Ash and never mention other projects.

After committing, inspect the diff and SHA with `git show` and recheck `git status`. Apply step 6's failure attribution to hooks too: never bypass a hook failure affecting the staged change; bypass only an unrelated failing check when necessary to complete the requested local commit, and report it. Verify that the commit excludes unrelated work and that unrelated working-tree changes remain intact. Stop here for commit-only requests.

## Publish to main

1. Verify the remote and authorized `main` target. Inspect every local commit that would be published; stop if the range contains unrelated or uncertain commits. Do not publish from a detached HEAD or switch branches over unrelated work.
2. Fetch the selected remote's `main` immediately before publishing. If it advanced, rebase only task-owned, unpublished commits onto that fetched head. Do not rewrite published or unrelated history. If the operation requires cleaning unrelated changes, stop instead of auto-stashing them.
3. Stop on ambiguous or out-of-scope conflicts. Review the integrated diff and revalidate changes introduced by rebasing or conflict resolution. Before pushing, reuse or rerun the repository commit gate against the fetched target under [the reuse conditions above](#prepare-the-exact-change). Capture the final commit SHA after any rewrite.
4. Push serially with an explicit non-force target, for example `git push <remote> HEAD:refs/heads/main`. Never force-push `main`. If a concurrent update rejects the push, perform one more fetch, safe rebase, and affected validation, then retry the normal push once. If it is rejected again or integration is unsafe, report the blocker rather than looping or overwriting remote work.
5. Read the remote ref after pushing. Verify that it equals the final commit SHA, or fetch and prove that SHA is an ancestor of the newer remote head if another commit arrived.

## Open the requested PR

1. Verify the repository, head branch, remote, and base branch from the request and repository configuration; do not assume a universal base such as `master`. Inspect the complete head-to-base diff and all commits to be published for task ownership.
2. Check for an existing open PR for that head and base. Report the existing PR instead of creating a duplicate. Do not edit its title, description, draft state, or unrelated content without authorization.
3. Fetch the selected remote's base branch and reuse or rerun the repository commit gate against that fetched ref under [the reuse conditions above](#prepare-the-exact-change). Push the authorized head branch without force and verify the remote commit. Stop on unexpected remote divergence. Fill the shared change template, then create the requested draft PR. Do not merge or enable auto-merge without a request.

## Report the observed result

Report the commit SHA, branch, publication or PR link, and checks run. Inspect CI for the published SHA; distinguish pending, failed, skipped, absent, and passed checks.
