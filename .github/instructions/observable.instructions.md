---
description: Guidelines for writing code using observables and deriveds.
---

# Observables

Use the APIs in [observable.ts](../../src/ash/base/common/observable.ts).

- Inside `derived` and `autorun`, use `.read(reader)` to track dependencies. `.get()` is an untracked read.
- Register the disposable returned by `autorun`. For resources recreated on each run, use `autorunWithStore`; its store clears before reruns and on disposal.
- `observableValue` does not dispose stored values. Keep their lifecycle with an explicit disposable owner.
- Batch synchronous related updates in `transaction(tx => ...)`; pass `tx` to setters. Transactions do not span asynchronous work.
- Use `observableFromEvent` to read event-backed state and `observableSignalFromEvent` for invalidation on every event. Do not assume `observableFromEvent` filters events by value equality.
