# Symphony inside Ash

`ash-symphony` ports the scheduling responsibilities described in
[Symphony specification](https://github.com/openai/symphony/blob/main/SPEC.md) into the shared Rust App Server.
It does not start an Elixir service or another coding-agent process.

The profile owns one scheduler and one SQLite store. This crate owns imported
workflows, tracker issue snapshots, dispatch reservations, controls and retries.
Core remains the owner of Sessions, Threads, Turns, messages, usage and timing.
The App Server supplies authenticated tracker IO and Core execution. Each renderer
uses its existing connection and keeps only a disposable presentation cache.

## Task inputs

Load an absolute `WORKFLOW.md` path from Symphony in the Agents Window. The
file's parent directory is the source project. Create tasks manually for any
imported workflow, or enable a GitHub/Linear tracker to import issues automatically.
The managed profile host remains alive while enabled trackers or runnable tasks
need it. Closing the monitor does not stop execution. Explicit host shutdown
cancels tracker and hook IO and joins scheduler workers.

```markdown
---
tracker:
  kind: local
agent:
  max_concurrent_agents: 3
  max_concurrent_agents_by_state:
    Todo: 1
  max_turns: 20
  max_retry_backoff_ms: 300000
  approval_mode: manual
polling:
  interval_ms: 30000
codex:
  stall_timeout_ms: 300000
---
Work on {{ issue.identifier }}: {{ issue.title }}
{{ issue.description }}
{% if attempt %}Resume existing work; batch {{ attempt }}.{% endif %}
```

GitHub uses `tracker.kind: github` and `tracker.provider.repo: owner/repository`.
Authentication comes from the profile's GitHub account. States default to `open`;
`required_labels` restricts dispatch. Linear uses `tracker.kind: linear` and
`tracker.provider.project_slug`; its key is referenced with
`tracker.provider.api_key: $LINEAR_API_KEY` (also the default). The host must have
that environment variable. Literal keys are resolved from the source file at IO time and never stored in
workflow records. `tracker.endpoint` and `tracker.assignee` (including `me`) are
also supported, either directly or inside `provider`; additional provider options
are retained. Linear defaults to `Todo` and `In Progress`, respects labels,
priority and unresolved Todo blockers. Tracker reads are paginated and bounded
at 2000 issues; partial reads and GraphQL errors cannot reconcile removals.
Successful full snapshots stop tasks that leave the selected project/state/labels.
Configure a Linear MCP integration in Ash when an agent needs to update Linear;
the scheduler itself polls and does not expose a `linear_graphql` agent tool.

## Scheduling and recovery

Reservations count against workflow and state concurrency before IO starts.
Normalized priority (1–4, then unspecified), creation time and identifier order
eligible issues. Dispatch and continuation refresh the issue by ID. Each reservation freezes
its workflow and prompt. Stable durable Core command IDs identify a task's first
Thread and every Turn. A delivery with an unknown outcome retries the same
command; it cannot create a second attempt until reconciliation proves the first
Turn ended. Pause/complete intents saved during IO win over later observations.
Resume keeps the same Thread, messages and cumulative usage.

Manual tasks finish after a successful Turn. Active tracker tasks continue in
batches up to `max_turns`, then schedule a new batch after one second. Failed
Turns retry with 10-second exponential backoff, capped by
`max_retry_backoff_ms`. A clean batch exit schedules attempt 1 after one second;
a failure after that uses attempt 2 and a 20-second delay. A retry without a slot
advances the same counter and backoff. In-batch continuation retains its worker
slot and runs immediately. Progress timeout observes
Core sequence receipts. Waiting for approval/input/capability does not count as a
stall. Nonpositive `stall_timeout_ms` disables detection. A stalled Turn is
interrupted before retrying.

Workflow files reload every two seconds. Changes affect future reservations and hook executions;
accepted Turn commands retain their frozen prompt and execution settings. Invalid reloads pause new
dispatch and leave accepted work intact. Workflow dispatch pause prevents new
reservations; individual task pause interrupts its active Turn. Neither action
deletes a conversation or its working directory.

## Upstream behavior and the Ash host

The reference is the checked-out upstream commit
`be10a1b79df723d6d7612b5651c8522704dafb2e`. Its complete, unchanged workflow is a
[test fixture](testdata/upstream-workflow.md); tests parse it and render its first
and retry prompts without executing its project scripts or contacting its tracker.
Strict Liquid rendering supports upstream filters, interpolation and control flow.
The first attempt receives `attempt: null`; retry batches receive the retry count.
Later Turns in a batch use the upstream continuation guidance.

For tracker workflows, `workspace.root` selects reusable issue directories
(default: the system temporary directory's `symphony_workspaces`). The worktree
crate owns creation, durable Thread bindings, recovery and removal. New directories
are empty when `after_create` runs, so upstream clone scripts can populate them.
Binding metadata is written afterwards. Existing directories skip `after_create`.
Manual workflows without a configured root keep Ash's ordinary isolated Thread
directory behavior. Changing the root applies to new work; a bound conversation
keeps its recorded root through retries and cleanup.

All four shell hooks use Ash's existing action policy and cancellable process
executor, with bounded output and a positive timeout (default 60 seconds).
The source project's directory must have Ash's existing execution authorization;
loading a workflow does not grant permission to execute commands.
User-hook provenance routes to the local process policy, using that owner's exact
revision. The default hook sandbox allows writes to its directory and denies
network access; scripts needing broader access require an explicit user-owned
`execPolicy` rule for their hook ID. Importing a workflow does not create such a
rule. Smoke fixtures explicitly authorize their four temporary logging scripts.
`before_run` and `after_run` bracket a worker batch, including a failed preparation.
An `after_create` failure removes the failed new directory; a `before_run` failure
retries the task. `after_run` and `before_remove` failures are logged and do not
change the worker result or prevent terminal cleanup. Terminal tracker states stop
accepted Turns before removal. Startup polling also cleans terminal directories
without an existing saved job. Nonterminal removal or loss of routing preserves
the directory. Containment and symlink checks run again after scripts.

Execution uses Ash Core, with the same owner of conversations, Turns, permissions
and tools as ordinary chats. `codex.command` model and reasoning-effort assignments
select an existing Ash model connection; ambiguous or unavailable model selection
fails visibly. Scalar approval policies map to Ash automatic/manual approval.
No external Codex process is launched. External executable arguments beyond model
and effort, Codex thread/turn sandbox objects, structured approval policies,
RPC read timeouts, SSH workers and the injected `linear_graphql` tool are not
implemented by this port. Use the existing Ash permission configuration and Linear
MCP integration. These host differences mean this is **not a claim of complete
upstream conformance**; loading the workflow alone does not establish that its
external access and project prerequisites are satisfied.

## Verification coverage

The scheduler tests cover durable reservations, controls winning over stale IO,
workflow reload failure, state/concurrency limits, blockers, normalized ordering,
strict Liquid errors, original workflow rendering, continuation prompts, retry
counters, slot retention, credential storage and cancellation. Worktree tests cover
empty creation, reuse, ownership, recovery, cleanup, escape and symlink rejection.
App Server tests cover shared profile access, durable Turn replay and paginated
Linear normalization, per-ID filters, routing and partial-read failures. Web and
Electron smoke scenarios exercise the actual Core execution, hooks, pause/resume,
cumulative tokens, retained conversation history and terminal directory removal.

The monitor reads cumulative token totals and active plus completed Turn duration
from Core. Paused time is excluded; incomplete provider usage is shown as a lower
bound. Its feed contains only user and assistant messages, currently the latest
300 messages. It does not surface code changes, commits, workspace status or
external editor actions.

Workflows without `agent.approval_mode` or an upstream scalar
`codex.approval_policy` inherit the profile's `[agent.execution].approvalMode`.
Explicit workflow policies override the default. Local agent commands use the
same command sandbox defaults as ordinary chats, with required directory grants
and managed network rules preserved. Hooks retain their own explicit user-scope
execution policy and never acquire authority from a workspace declaration.
