---
name: commit-pr
description: Commit Ash changes, publish them to main, or open a pull request when the user requests that outcome. Keep the requested scope, preserve unrelated work, and report actual validation.
---

# Commit and Publish

Finish the requested Git outcome without broadening it. This skill supplies a workflow, not permission to commit, push, open a PR, merge, or deploy.

## Choose the requested outcome

- **Commit only:** Create the local commit and stop. A commit request does not imply publishing.
- **Commit and publish to main:** Use this path only when publication to `main` is authorized. Ash does not require a PR for every owner-led change.
- **Pull request:** Use this path only when a PR is requested. Open it as a draft unless the user specifies otherwise.

If the outcome, repository, or publication target is unclear, ask the smallest necessary question before that action. Use the checkout or worktree the user named; do not silently substitute a clone.

## Prepare the exact change

1. Read [AGENTS.md](../../../AGENTS.md), the full [repository instructions](../../../.github/copilot-instructions.md), and every scoped instruction matching the changed files. Follow their ownership and validation rules.
2. Inspect the branch, remotes, working tree, index, and changes before staging: `git status --short --branch`, `git remote -v`, `git diff`, and `git diff --cached`. Read relevant untracked files too. Check for an existing merge or rebase before starting another operation.
3. Identify the task-owned files and hunks. Preserve unrelated changes. If the index includes unrelated or uncertain work, stop and ask; do not unstage, stash, reset, or overwrite someone else's work. If one file mixes task and unrelated edits, stage only the task hunks after reviewing them, or stop when they cannot be safely separated.
4. Run the smallest applicable checks against the final change. Record commands, completed results, failures, and relevant checks not run with their reasons. Documentation-only changes need documentation checks, not claims of runtime coverage.
5. Stage exact paths or reviewed hunks. For example, `git add -- .agents/skills/commit-pr/SKILL.md` stages that reviewed file only. Do not use `git add -A`, `git add .`, or `git commit -a` to collect a dirty tree. Review `git diff --cached` and `git diff --cached --check` immediately before committing; the entire staged diff must belong to this task.

## Write and verify the commit

Use [the shared change template](../../../.github/pull_request_template.md) as the single source for commit subjects, bodies, and PR descriptions. Keep the commit subject on one line, then a blank line and the template's three required headings in order, with blank lines after headings and between sections. Keep the sections separate in both commit bodies and PR descriptions; never put body text in the subject. Read the template's current guidance and fill it with the reason, resulting behavior, and validation actually performed. Do not copy its comments or leave placeholders. Keep one logical change per commit; do not split merely by file type.

Create the requested commit, then inspect its actual diff and SHA with `git show` and recheck `git status`. A failed hook is a failure to resolve or report, not permission to bypass hooks. Verify that the commit excludes unrelated work and that unrelated working-tree changes remain intact. For commit-only requests, report the local result here.

## Publish to main

1. Verify the selected remote identifies the intended repository and that `main` is the authorized target. Inspect every local commit that would be published, not just the latest diff. Stop if that range contains unrelated or uncertain commits. Do not publish from a detached HEAD or switch branches over unrelated work.
2. Fetch the selected remote's `main` immediately before publishing. If it advanced, rebase only task-owned, unpublished commits onto that fetched head. Do not rewrite published or unrelated history. If the operation requires cleaning unrelated changes, stop instead of auto-stashing them.
3. Resolve only understood conflicts within the authorized change; stop on ambiguous or out-of-scope conflicts. Review the integrated diff and rerun checks affected by rebasing or conflict resolution. Capture the final commit SHA after any rewrite.
4. Push serially with an explicit non-force target, for example `git push <remote> HEAD:refs/heads/main`. Never force-push `main`. If a concurrent update rejects the push, perform one more fetch, safe rebase, and affected validation, then retry the normal push once. If it is rejected again or integration is unsafe, report the blocker rather than looping or overwriting remote work.
5. Read the remote ref after pushing. Verify that it equals the final commit SHA, or fetch and prove that SHA is an ancestor of the newer remote head if another commit arrived. A successful push message alone is insufficient.

## Open the requested PR

1. Verify the repository, head branch, remote, and base branch from the request and repository configuration; do not assume a universal base such as `master`. Inspect the complete head-to-base diff and all commits to be published for task ownership.
2. Check for an existing open PR for that head and base. Report the existing PR instead of creating a duplicate. Do not edit its title, description, draft state, or unrelated content without authorization.
3. Publish only the authorized head branch with a normal non-force push and verify the remote commit. Stop on unexpected remote divergence. Fill the shared change template from the final diff and actual validation, then create the requested draft PR. A PR request does not authorize merging, auto-merge, or deployment.

## Report the observed result

Give the commit SHA and branch, publication or PR link when applicable, checks actually run, and any blocker or coverage limit. Inspect CI for the exact published SHA and distinguish pending, failed, skipped, absent, and passed checks. Do not call all CI green when checks are incomplete, unavailable, or only a subset was inspected. Say what remains before claiming the change is ready to merge.
