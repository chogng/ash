---
name: auto-perf-optimize
description: Investigate Ash performance or memory with a repeatable Ash scenario, runtime assertions, and renderer CDP measurements. Use for heap snapshots, CPU profiles, or before/after scenario comparisons; the inherited VS Code Chat runners are not Ash runners.
---

# Ash Performance Workflow

Define a warmup action, a repeatable iteration, and an observable settled state. Run a small scenario first, then collect only the measurements needed to investigate the suspected growth or latency. Check that the intended workflow completed before interpreting memory data.

For typing, undo, large-file editing, folding or outline latency, use [editor-perf-optimize](../editor-perf-optimize/SKILL.md) for the editor's input-to-readiness measurements and renderer/backend/extension investigation.

For streaming responses, transcript rendering, or Chat session retention, use [chat-perf](../chat-perf/SKILL.md) for controlled workloads and completion criteria.

## Low memory footprint

When the goal is low absolute memory use, measure that separately from leak growth. Establish cold startup, project-ready idle, warmed representative use, and a settled state after closing or releasing the workload. Add a sustained run when investigating long-term growth. Use the user's memory budget when specified; otherwise establish the baseline before proposing a numeric target.

Identify each owned Main, Renderer, GPU/utility, App Server, extension, worker, and tool process, including background work left after the feature closes. Distinguish RSS or platform footprint, V8 heap and backing storage, Rust allocations, and GPU resources. RSS sums can count shared pages repeatedly. A small post-GC JS heap does not explain a large process footprint.

Match build mode, workspace, open views, enabled features, profile state, and instrumentation. Development builds and video/trace capture can change the baseline; do not present those absolute values as packaged-product idle usage. Capture functional evidence separately when recording would distort the footprint being measured.

Follow the measured allocation owner. Check eager process startup, unused background work, duplicate data, caches and resource pools for avoidable retention. A bounded cache can still be too large for the workload; evaluate its memory cost and reuse latency. Verify first use, reuse, background activity, unsaved state and release after making resources lazy or evictable. Do not lower the result by skipping required work or hiding failed providers.

## Run an Ash scenario

Use the existing `test/scenario/src/runScenario.ts` entrypoint and [scenario guide](../validate-ui-scenario/SKILL.md) for the scenario contract, preparation, and evidence output. Inspect that guide when launching a real application. Reuse preparation that still covers the current source.

After preparation and scenario compilation:

```bash
node test/scenario/out/runScenario.js <scenario.cjs>
# Web scenarios use the same runner and support headless execution.
node test/scenario/out/runScenario.js <scenario.cjs> --web --headless
```

Use the scenario context's `page`, `driver`, and `workbench` for assertions and actions. Keep selectors and completion conditions with the scenario. Screenshots and evidence reports help diagnose a failure; runtime assertions establish that the measured operation happened.

For renderer measurements, create a CDP session from `context.page.context().newCDPSession(context.page)`. Enable `Performance` for metrics or `HeapProfiler` for memory sampling. Collect garbage at comparable settled points, label a warmed-up baseline and a later iteration, and stream `HeapProfiler.addHeapSnapshotChunk` events to a file when taking snapshots. Detach the session and remove its listeners in `finally`. Never report a measurement as valid if startup, authentication, the measured action, or quiescence failed.

Write raw samples and scenario parameters under an ignored `.build/` investigation directory. Record errors alongside partial samples. Compare the same workflow, labels, cache conditions, and profile policy before and after a fix. Large heap snapshots are optional; avoid collecting one per iteration unless the investigation needs it.

## Cancellation and ownership

Send Ctrl-C / SIGINT or SIGTERM to the scenario runner. Its supervisor stops the worker and cleans registered product processes and test-owned backend profiles. A second interrupt skips the graceful wait. Wait for the actual command to exit and confirm its resources are gone before reporting it stopped. Killing an orchestration cell alone does not establish that external processes stopped.

Attaching to an existing application does not transfer ownership. Preserve that application and any user-provided profile. Use a temporary workspace when a Chat scenario can execute tools; prompts should exercise the intended behavior without modifying unrelated work.

## Inherited VS Code scripts

`chat-memory-smoke.mts` and `chat-session-switch-smoke.mts` retain VS Code-specific Chat selectors and startup arguments. They are unavailable for Ash and fail before launching a product; `--help` explains the supported Ash route. Do not copy their `scripts/code.sh`, `globalThis.driver`, or `src/vs` assumptions into an Ash runner.

`workbench-css-performance.mts` targets an explicitly selected VS Code checkout through `--code-root`. It is a comparison tool, not Ash validation. Its owned-process cancellation uses the shared process owner. Explicit `--keep-open` leaves that comparison application open; do not treat it as a completed cleanup check.

`userDataProfile.mts` remains a profile-copy helper. Copy a seed only while its application is closed, preserve explicit user-provided profiles, and keep profiles with authentication data in ignored local output.

## Investigation and verification

Trace allocation and disposal ownership before changing product code. Use [heap-snapshot-analysis](../heap-snapshot-analysis/SKILL.md) for snapshot comparisons and retainer paths, or [cpu-profile-analysis](../cpu-profile-analysis/SKILL.md) for CPU evidence. Preserve raw evidence and record what was measured, what changed, and what remains uncertain.

Run the smallest checks covering a fix, following [testing guidelines](../../../.github/instructions/testing.instructions.md). Reuse successful results when their inputs still cover the current changes. Performance comparisons may need intentional repeated sampling; committing or pushing does not require another test run. Do not expand to full unit or integration suites merely because a performance investigation finished.

## Learnings

- For retained view switching, measure synchronous dispatch, selector DOM additions/removals, and renderer layout/style counts alongside visibility and focus assertions. Preserve action identity so ActionBar can reuse its view items; bound and dispose caches by registered items, and replace actions when their displayed content changes. Notify Grid only when hosted constraints change, and deduplicate allocations using actual content dimensions while invalidating on active-owner or visibility changes and preserving synchronous first-show, title-change, and resize geometry. Cover overflow and unpinned items, badges, drag order, keyboard/ARIA, and hidden-resize geometry before comparing matched warm workflows; a prototype patched only in a test process provides causal evidence, not acceptance of the production fix.
