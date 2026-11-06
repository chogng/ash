---
name: chat-markdown-perf
description: Diagnose and optimize Ash Chat streaming Markdown, including frame buffering, tail parsing, DOM reuse, completion spikes, and correction fallback. Use when measuring or changing how streamed Markdown reaches the visible transcript.
---

# Chat Markdown streaming performance

## Trace the update

Follow the same response through these owners before choosing where to optimize.

| Boundary | Owner and evidence |
| --- | --- |
| Source and corrections | On the App Server path, Thread state owns the response source. Trace the delivered text, response identity and completion flag to `ChatListWidget` and `ChatListItemRenderer`. Measure transport separately when delivery is the suspected delay. |
| Frame admission | `chatIncrementalRendering/chatIncrementalRendering.ts` owns the pending snapshot, frame handle, visibility and cancellation. A newer correction or completion can supersede queued text. Short updates can render synchronously. |
| Parse and commit | `ChatMarkdownContentPart` owns rendered fragments, selection and code models. `chatMarkdownTail.ts` validates resumable source boundaries. `ChatContentMarkdownRenderer` supplies the rendering options and trust policy. |
| DOM effects | `ChatMarkdownDecorationsRenderer` owns live link bindings. `ChatListWidget` owns viewport measurement, reading anchors and follow-to-bottom. Inspect the time spent here alongside the lexer and sanitizer. |

For file or API alignment, use the local VS Code checkout and the [vscode-api-alignment skill](../vscode-api-alignment/SKILL.md). Compare the frame scheduler and Markdown renderer as separate responsibilities. Ash's lexical checkpoints and sanitized DOM reconciliation belong to its Markdown path.

## Reproduce the costly frames

Use `runMarkdownBenchmark` in the [transcript fixture](../../../test/fixtures/browser/chatTranscript.page.ts) through the production `ChatListWidget`. Start with the shape that reproduces the issue. Long paragraphs, lists and tables expose repeated tail work. Fences and math candidates exercise different consumers. Preserve the exact baseline sources and fixture settings before editing, including any relevant uncommitted changes.

Run the repository's existing comparison for large tails:

```bash
ASH_MARKDOWN_BENCHMARK_LABEL=baseline pnpm test:browser:integration \
  chatTranscript.integration.spec.ts --project=chromium --workers=1 \
  --grep 'streaming Markdown large tail delivery costs'
```

Repeat with label `candidate` after the change. The [integration spec](../../../test/integration/browser/chatTranscript.integration.spec.ts) attaches raw samples and checks completed DOM. It sends 128 cumulative snapshots at eight updates per frame. For a per-commit comparison, parameterize the same fixture-only cadence to one update per frame in both builds. Confirm 128 input samples and 128 commit samples for that run. With batched delivery, record the actual commit count separately. Warm each build and alternate repeated samples when both builds are available. Store raw data and any one-off instrumentation in ignored `.build/` output.

Record these phases separately:

- Synchronous snapshot handling (`updateSamplesMs`) and Markdown DOM commit (`renderSamplesMs`). Report commit P95 and the terminal commit median. Group slow frames by source length and completion state to catch size thresholds and terminal spikes.
- Lexer input length and time by frame when parsing is hot. Keep source length units explicit and account for lexer time as part of the commit. Inspect HTML sanitization, node mutations and layout when lexer work falls and commit time stays high.
- Chromium CDP `TaskDuration`, `LayoutCount` and `LayoutDuration` when evaluating renderer or scroll cost. Report an enqueue improvement separately when total renderer work stays similar. Keep CPU profiling outside formal timing samples. `ASH_MARKDOWN_CPU_PROFILE=largeList` captures a separate profile in the existing large-tail test.

## Change the measured owner

- When appending a new block spikes, inspect both block discovery and rendering. A terminal `\n\n` can trigger a full discovery scan and then a second full parse when the separator invalidates a tail checkpoint. Resume discovery from a proven checkpoint and keep the separator in source offsets while excluding it from the resumed block input. Recheck both lexer calls in the terminal frame.
- Treat checkpoints as provisional. Require a verified source prefix, matching rendering policy and valid block shape before reusing committed content. Reparse from the affected boundary on correction and reconsider the preceding block when the new text can be a continuation. Use canonical parsing when a late reference definition, list looseness, HTML, math scope or extensions can change earlier output. Compare the completed result against the full renderer.
- When DOM work dominates, preserve stable nodes and their owned bindings, then sanitize and reconcile the changed range under the existing Markdown policy. For a growing table row, compare changed cells and new rows while preserving the semantic table and intrinsic column sizing. Measure node identity and resource cleanup as well as mutation counts.
- When enqueue forces layout, distinguish a snapshot that only enters the frame queue from a synchronous DOM mutation. Measure the deferred commit separately. Preserve the reading anchor around structural mutations and let committed geometry drive scroll updates.

## Verify the behavior at risk

- Exercise append, completion and provider correction through the normal renderer entry. Select affected fallback cases such as setext conversion, a loose or indented list continuation, table shape changes, and a reference definition arriving after its use. Include the affected extension or trust policy when touching those paths.
- Compare normalized DOM against a complete render and check live node identity separately. Limit normalization to known irrelevant output differences such as top-level whitespace between block elements. Check the interactions the change can affect, including table column widths and keyboard scroll, selection and focus, link binding disposal, and bottom-follow versus a user reading earlier content.
- For scheduling changes, verify latest-snapshot wins, hide and resume, clear, and disposal. Check the cases in `chatContentMarkdownRenderer.test.ts`, `chatTranscript.test.ts`, and `chatListWidget.test.ts` under `src/ash/workbench/contrib/chat/test/browser/`.
- Use [the streamed Chat response smoke spec](../../../test/smoke/areas/chat/chat-response-stream.spec.ts) when validating the real Electron and App Server path. Report this separately from the controlled Chromium timings. Include the workload, cadence, sample counts, affected metrics and any validation gaps in the result.
