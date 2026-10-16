---
name: chat-perf
description: Investigate Ash Chat streaming, transcript rendering, session switching, and retained memory using controlled responses and existing browser or Desktop runners. Use for Chat performance or memory regressions; editor typing belongs to editor-perf-optimize.
---

# Chat performance and retained memory

Adapted from VS Code's [chat-perf workflow](https://github.com/microsoft/vscode/blob/9ec085756845ef1e24e5623fc05bf6cf70ed4956/.github/skills/chat-perf/SKILL.md). Its `npm run perf:chat`, `perf:chat-leak`, `scripts/chat-simulation`, release downloads, selectors, and mock-agent setup are not Ash entrypoints. This skill provides an Ash investigation workflow, not a new benchmark command.

Use [auto-perf-optimize](../auto-perf-optimize/SKILL.md) for application preparation, process ownership, capture, comparable memory checkpoints, and whole-process budgets. Use [heap-snapshot-analysis](../heap-snapshot-analysis/SKILL.md) for the resulting V8 snapshots. Keep one-off scenarios, raw samples, and analysis under `.build/`.

## Choose the boundary

| Question | Existing Ash starting point | Evidence boundary |
| --- | --- | --- |
| Markdown, code blocks, tool rows, focus or disclosure rendering | `test/integration/browser/chatTranscript.integration.spec.ts` and `chatTranscript.integration.ts` | Controlled browser component; does not cover backend streaming or Desktop footprint. |
| Provider stream through durable Thread state into live widgets | `test/smoke/areas/chat/chat-response-stream.spec.ts` | Local synthetic SSE responses through the real App Server and Chat pipeline. |
| Desktop session switching, hidden views, or resources after closing Chat | `test/scenario/src/runScenario.ts` with a focused `.cjs` scenario | Real Desktop workflow with isolated workspace and profile. |

Inspect the selected fixture and production caller before extending it. Reuse its response shape, request identity, and completion assertions. Fixture-only globals such as `ashChatTranscriptIntegration` belong to the integration page; they are not available in the product window.

To discover existing coverage without starting a benchmark:

```bash
pnpm test:browser:integration chatTranscript.integration.spec.ts --project=chromium --grep 'Response code blocks' --list
pnpm run test:smoke:desktop:no-compile test/smoke/areas/chat/chat-response-stream.spec.ts --grep 'Real streamed Chat responses' --list
```

Follow [integration-tests](../integration-tests/SKILL.md) or [smoke-tests](../smoke-tests/SKILL.md) for running the selected coverage. `--list` proves only selection, not a successful scenario. Reuse prepared Desktop artifacts only while they cover the current sources.

## Define the workload and endpoint

Record response bytes, chunk sizes and cadence, message and tool counts, code-block sizes, session count, active versus hidden views, and enabled features. Use controlled local responses where possible so provider latency and changing output do not mask rendering changes. Use synthetic content and the runner's isolated profile; do not rely on a personal authenticated Chat history.

For timing, distinguish first visible response, final rendered content, and the settled state after streaming and tool work end. Assert the expected text and real request completion independently. Measure from the relevant stream/input event to its matching visible result; the command picker closing or the first unrelated DOM mutation is not that endpoint. Keep forced GC, heap snapshots, and expensive allocation tracing outside timed intervals.

For memory, choose the comparison that answers the question:

- **Growing conversation:** record retained transcript bytes and item counts beside heap and process samples. History growth is expected and cannot be treated as a leak or judged by a universal MiB-per-message threshold.
- **Released conversation:** warm the renderer, open or stream the same bounded workload, switch away or close it according to the owning model's lifecycle, and sample after pending work settles. Compare equivalent visible and background activity; an in-flight turn can legitimately keep a model alive.
- **Large baseline:** inspect resident processes, background workers, retained hidden views, caches, images, and duplicate transcript or serialization data even when the post-GC heap is stable. Verify first use and reuse after making work lazy or evicting derived data.

Start with a small successful iteration. Add repetitions when needed to separate first-use caches from continued growth. Preserve per-iteration samples and failures; missing responses, crashed providers, and canceled operations do not count as memory improvements. Use the same build mode, settings, profile policy, responses, and instrumentation for a before/after comparison. Single runs are observations; collect repeated samples before claiming a stable regression or reduction amid noise.

## Verify the affected behavior

When optimizing transcript retention or rendering, exercise the affected content and state: streaming updates, code selection and copy, tool expansion, reading position, focus, hidden-session updates, cancellation, and reopening as applicable. Verify active background requests and drafts survive the intended navigation. Derive the smallest checks from the changed owner instead of running every Chat test.

For a persistent-growth hypothesis, trace current heap retainers and release ownership before changing product code. After the fix, replay the same workload, compare the appropriate settled samples, and confirm the content still renders and resources remain usable. Report component-only, App Server, and Desktop coverage according to what actually ran.
