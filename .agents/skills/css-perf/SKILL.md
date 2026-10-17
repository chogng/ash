---
name: css-perf
description: Measure Ash CSS style recalculation and layout cost with renderer CDP metrics and matched before/after scenarios. Use for selector invalidation, class mutations, resize, or CSS-related interaction regressions; static style reviews alone do not require a benchmark.
---

# CSS performance

Save an Ash `.cjs` scenario and raw samples under `.build/css-perf/<investigation>/`. Run it with `pnpm scenario <scenario.cjs>`; when this checkout's backend and Desktop build are already current, use `pnpm scenario:compile` followed by `node test/scenario/out/runScenario.js <scenario.cjs>`. The scenario step receives `page`, `driver` and `workbench`; use their current APIs. Desktop claims require Desktop measurements.

## Define the claim and baseline

Choose the affected surface, operation and observable completion condition. Record source/build identity (including dirty inputs), scenario, Chromium version, fixture, mounted DOM/target counts, viewport/scale, theme, open views, cache policy and instrumentation. Keep these conditions matched before and after; distinguish virtualized model size from mounted rows.

Search suspicious selectors, including rules emitted from TypeScript, and inspect their DOM owners. Selector length or the presence of `:has()` alone does not establish a bottleneck.

## Choose the workload

| Workload | Exercise and verify | What it answers |
| --- | --- | --- |
| Class mutations | Add/remove a unique, unstyled class on a nonempty set of affected elements; check it has no delegated behavior. Restore classes in `finally` and record target counts per round. | Style invalidation from unrelated class changes. |
| Forced resolution | After each probe mutation, read the same layout-dependent property, such as `document.body.offsetWidth`; record batch size. | Diagnostic style/layout cost. Forced reads alter scheduling, so measure separately from natural interactions. |
| Resize | Alternate fixed window sizes and assert viewport and affected geometry. Use the Desktop harness's window API; `page.setViewportSize()` need not resize an Electron window. | Responsive style/layout cost. |
| Tabs, tree focus, view toggles | Drive real actions and assert selected content, focus and final visibility; restore the starting state. | Interaction latency and renderer work. A full-recalculation microbenchmark cannot substitute for this result. |

## Collect renderer samples

Create a CDP session with `page.context().newCDPSession(page)`, enable `Performance`, and detach in `finally`. Measure cumulative metric deltas around the action and its matching readiness assertion, after setup has settled. CDP durations are seconds. Add `ScriptDuration`/`TaskDuration` when JavaScript may explain the difference; these durations can overlap and must not be summed as independent costs.

For example, this helper belongs inside a scenario step that owns `page` and `cdp`:

```js
async function metrics() {
    const { metrics } = await cdp.send('Performance.getMetrics');
    const result = Object.fromEntries(metrics.map(({ name, value }) => [name, value]));
    for (const name of ['RecalcStyleDuration', 'LayoutDuration', 'RecalcStyleCount', 'LayoutCount']) {
        if (!Number.isFinite(result[name])) throw new Error(`Missing CDP metric: ${name}`);
    }
    return result;
}

async function measure(actionAndAssertReady) {
    const before = await metrics();
    const start = performance.now();
    await actionAndAssertReady();
    const wallMs = performance.now() - start;
    const after = await metrics();
    const delta = name => {
        const value = after[name] - before[name];
        if (value < 0) throw new Error(`CDP metric reset: ${name}`);
        return value;
    };
    return {
        wallMs,
        recalcStyleMs: delta('RecalcStyleDuration') * 1000,
        layoutMs: delta('LayoutDuration') * 1000,
        recalcStyleCount: delta('RecalcStyleCount'),
        layoutCount: delta('LayoutCount'),
    };
}
```

Wall time includes automation and assertion overhead. An animation frame alone does not prove asynchronous completion or physical display. CDP metrics cover the selected renderer, excluding other windows, workers, Main, Rust and GPU work.

The scenario runner records tracing/video. Put measurement loops inside one step to exclude evidence screenshots and step pauses, and keep capture settings matched. Collect diagnostic CPU/DevTools traces separately if needed; do not attribute recording overhead to CSS.

Persist raw samples with phase, round, warmup/measured status, operation count and assertion outcome. Preserve errors and partial data, but exclude failed runs from successful comparisons.

## Compare and verify

After a small successful run, collect repeated rounds after warmup. Report sample count, median and spread; distinguish repetitions in one process from independent launches. Bracket the changed build with baseline runs (A/B/A) or alternate comparable runs when host-load drift is significant.

Report style/layout duration and count, wall time and functional outcome per phase. Explain count changes against equivalent completed work. Noisy or below-resolution results are inconclusive; a duration decrease alone does not establish causality. Label temporary stylesheet substitutions as microbenchmarks, separately from rebuilt-product comparisons.

Verify affected selector behavior, including relevant decoration, hover/focus, theme and dynamic states. Deliver raw samples, scenario/report paths, build identities and limitations.

Measurement approach adapted from the [VS Code CSS performance report](https://github.com/microsoft/vscode/blob/02e057f92ab433a020927c47bf877bab8b748dd7/src/vs/workbench/contrib/modernUI/CSS_PERFORMANCE.md); its timings are not Ash measurements.
