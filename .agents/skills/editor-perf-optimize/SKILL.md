---
name: editor-perf-optimize
description: Diagnose and optimize Ash editor typing, undo, large-file, folding and outline latency across the renderer, syntax backend and language extensions. Use for editor performance or retained-memory investigations with real Desktop before/after measurements.
---

# Editor performance

Establish which part of an editor action the user is waiting for, find the process that owns that delay, and verify the change against the same Desktop workload. A faster parser alone does not establish faster editing.

Use [auto-perf-optimize](../auto-perf-optimize/SKILL.md) for scenario ownership, CDP collection and comparable memory samples; use its linked scenario guide when launching Desktop. This skill adds editor-specific measurements and investigation decisions. Keep scratch scenarios, source snapshots, raw samples and profiles in an ignored `.build/` directory.

## Define the comparison

Record file bytes, lines and content shape, language, open-tab count, edit location and operation, warmup, repetitions, enabled features, backend execution mode and profiling/GC policy. Include a realistic tab population when latency may depend on other open documents. Distinguish first open/activation, first edit and steady-state editing: warming a cache changes the question being measured.

Preserve the baseline before editing, including the fixture contents rather than a moving corpus path. Validate language/file mappings before launching a generated workload. Record the working-tree diff and relevant source hashes alongside Desktop build and prepared backend identity; a commit SHA alone cannot identify a dirty checkout. When extension sources change, inspect the current preparation scripts: browser extension assets may need `pnpm prepare:extensions` before `pnpm prepare:backend`. A rebuilt backend alone does not establish fresh webview assets. Finish compilation and functional checks before formal timing begins.

Choose enough repeated actions to expose the reported problem, rather than fixing one universal file size or sample count. Keep the same workload and cache policy before and after. Use a separate profiling run so instrumentation does not silently change the timing comparison.

## Measure the whole action

For typing/undo, read [measurement.md](references/measurement.md) before adding instrumentation. Capture the actual browser input event timestamp, the matching visible text change, its next animation frame, and the matching document revision's applied syntax facts. Report these endpoints separately. `max(frame, facts) - input` describes this combined readiness contract; it does not include all background language features or prove a frame was physically displayed.

Assert content, revision and execution mode independently of timing collection. A new telemetry entry for another document, an old revision, or a completed command-picker action cannot stand in for the intended result. For scrolling or feature commands, define the corresponding visible/semantic endpoint instead of forcing the typing metric onto them.

Preserve samples even if a later step fails, but label them partial. The helper below summarizes the typing format described in the reference, checks sample counts and rejects failed/incomplete scenario evidence:

```bash
python3 .agents/skills/editor-perf-optimize/scripts/summarize.py \
  .build/editor-perf/before/samples.json \
  --manifest .build/ash-playwright-mcp/evidence/<run>/manifest.json \
  --expected-edits 30 --output .build/editor-perf/before/summary.json
```

`30` is an example, not a required workload. The helper exits nonzero for invalid evidence and retains diagnostic statistics with `valid: false`. A valid summary still needs a matched comparison and the scenario's independent correctness assertions.

## Find the owner of the delay

Trace one measured revision across the boundaries it actually uses:

| Where time grows | Inspect next |
| --- | --- |
| Input event → visible DOM/frame | Renderer CPU profile: model edits, undo/history, line identity, editor-group/tab updates, serialization, scheduling, layout and paint. Look for work proportional to total lines or tabs on a local edit. |
| Rust parse/query time | Incremental edit normalization, edited byte/UTF-16 ranges, invalidated tree regions, injections and query scope. Verify both insert and undo; one can trigger much more work. |
| Parse is quick, facts arrive late | Queue wait, transport payload conversion, full versus delta facts, client application and follow-up notifications. Do not subtract timestamps from different process clocks. |
| First edit or many open documents | Language activation, cold analysis, workspace scans, repeated client document reads and per-document diagnostics. Compare cold initialization separately from warmed updates. |
| Periodic stalls or growing retained memory | Worker/extension lifecycle, pending callbacks, broker sessions, timers and cancellation cleanup. Inspect the owning process, not only renderer heap. |

Use [cpu-profile-analysis](../cpu-profile-analysis/SKILL.md) for V8 profiles and [rust-development](../rust-development/SKILL.md) for Rust validation. For concrete pitfalls in incremental state and extension protocols, read [boundaries.md](references/boundaries.md). Follow the existing domain owner; a performance fix is not a reason to move optional language policy into the shared editor backend.

Change the demonstrated bottleneck, then rerun the narrow measurement that exposed it. If parser time improves but whole-action latency does not, retain the improvement only if justified and trace the remaining interval. Do not report a component benchmark as the end-to-end result.

## Verify the editor still works

Exercise the feature that could have been skipped or broken by the optimization: edited text and undo, affected tokens, folding boundaries, outline entries, diagnostics or preview as appropriate. Include Unicode and structural changes when range or identity logic changed. Check expected UI limits before interpreting a missing virtualized item or capped fold region as a backend failure.

After sustained edits, allow the implicated background queue/deadline to settle and invoke a language-extension feature again. Shared Tree-sitter folds/outline can keep working while a separate language extension has failed. Inspect that extension's named Output channel and lifecycle if commands disappear. Lower memory or fewer workers can reflect a crashed provider; verify it remains usable before calling the change an improvement.

Run focused owner checks and the Desktop scenario on the final sources. Reuse still-applicable successful checks. Deliver matched distributions with sample counts, the endpoint measured, functional outcome and evidence paths. Identify blocked checks, partial runs and remaining latency explicitly.
