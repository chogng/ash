# Input-to-readiness measurement

## Clocks and causality

Install input observers before driving the edit. On Desktop, inspect the active editor's actual input target: EditContext `textupdate` may carry inserted text while undo is identified by the triggering `keydown`. Do not assume a textarea `input` event always exists. Use `event.timeStamp` on the page's performance time origin, retaining `performance.now()` as `observedAt` only to diagnose listener delay. A listener can run after substantial synchronous editor work; using its arrival time as input start hides that work.

Arm each action with the current document revision and a content predicate. Observe the active editor's rendered text using a MutationObserver; record `performance.now()` when the predicate first becomes true and request an animation frame for a separate `frame` timestamp. Ensure undo restores the expected original text, rather than merely observing any mutation. A RAF callback is a useful scheduling endpoint, not proof of completed paint. Use a browser trace if paint/presentation is the claim.

Observe `ash.treeSitter.*` measures with a PerformanceObserver and filter by the exact document and the revision produced by the action. Inspect current telemetry call sites to verify that `ash.treeSitter.facts` is emitted after client application. Store its observer time as `facts`; the measure's backend duration is a separate component measurement. Observer delivery may add delay, so name it accurately. Existing `detail.execution` identifies the actual backend. Keep `completed`, `version`, model identity and durations in raw records.

Await all required endpoints before disarming; checking only text and facts can race the RAF. Disconnect observers, input listeners and CDP sessions in `finally`, including failed actions. Do not insert artificial sleeps or forced GC inside measured edits. Wait for a revision/content predicate, then collect memory at separately labelled settled points.

Never subtract Node `perf_hooks.performance.now()` or a Rust monotonic timestamp from a browser timestamp. Node wall-clock timings can describe the automation round trip separately. Inclusive profile frames and overlapping backend stages must not be added as independent costs.

## Summary helper input

`scripts/summarize.py` consumes a JSON object with `runtimeErrors`, `errors` and `files` arrays. Each file has a unique `name` and an `edits` array of measured actions only. Keep warmups outside that array. Each edit contains:

```json
{
  "operation": "insert",
  "armed": 1000,
  "inputAt": 1002,
  "inputs": [{"type": "textupdate", "at": 1002, "observedAt": 1014, "text": " MARK"}],
  "dom": 1013,
  "frame": 1018,
  "facts": 1040,
  "previous": 7,
  "events": [{
    "name": "ash.treeSitter.facts",
    "at": 1040,
    "detail": {"completed": true, "version": 8, "model": "/fixture/sample.md", "execution": "rust"}
  }]
}
```

For undo, record `operation: "undo"` and the triggering `keydown` with `key: "z"`. Timestamps are nonnegative milliseconds on the same page clock. Preserve all raw events, including the selected input; the summarizer checks that the chosen input really appears in that event list and that completed facts correspond to a newer revision of that file. The scenario must additionally assert the exact target revision and expected content. A filename in this compact format must uniquely identify the document within the workload.

The helper requires an explicit expected count per file and the runner's finalized manifest. It reports nearest-rank p50/p95, min and max for input→DOM, input→RAF, input→facts and input→combined readiness. It never silently drops invalid samples or substitutes zero for missing endpoints. It validates all recorded manifest steps finished successfully; the scenario author must include the relevant functional checks in the first place. Preserve parameters, source/build provenance and memory metrics in the raw file or adjacent artifacts; the summary does not establish comparability for you.
