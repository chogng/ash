---
description: Ash TypeScript resource ownership and cancellation guidelines
---

# Lifecycle

Ash uses the ECMAScript explicit resource-management protocol as its foundation and exposes a small project facade for application code.

## Protocols

- `Disposable`, `[Symbol.dispose]()` and `using` are the synchronous protocol.
- `AsyncDisposable`, `[Symbol.asyncDispose]()` and `await using` are the asynchronous protocol.
- `AbortSignal` represents cancellation of one asynchronous operation; it does not represent ownership and must not dispose the object performing the work.
- Keep synchronous and asynchronous cleanup separate; do not define `dispose(): void | Promise<void>`.

Lifecycle, cancellation, and shared error categories are separate base modules:

```text
base/common/
├─ lifecycle.ts
├─ cancellation.ts
└─ errors.ts
```

`errors.ts` owns project-wide error types and classification, including `CancellationError` and `isCancellationError`. `cancellation.ts` owns cancellation tokens and the mechanisms that observe `AbortSignal` or `CancellationToken` and produce those errors. `lifecycle.ts` must not depend on cancellation.

## Project facade

- `IDisposable` extends the standard `Disposable` protocol with explicit `dispose()` and is the project type for synchronous resources.
- `IAsyncDisposable` extends the standard `AsyncDisposable` protocol with explicit `disposeAsync()`.
- `Disposable` is the VS Code-style composite base class. It owns a protected `_store`, exposes `_register<T>()`, and provides `Disposable.None` for an intentionally empty resource.
- `AbstractDisposable` is for stateful leaf resources that implement custom cleanup in `disposeCore()`.
- `DisposableStore` owns a reusable group in LIFO order. `clear()` releases the current group and permits new registrations; `isDisposed` reports the terminal state.
- `MutableDisposable<T>` owns one replaceable resource through `value`; replacing or clearing releases the previous value, while `clearAndLeak()` transfers it without releasing it.
- `AsyncDisposableStore` owns synchronous and asynchronous resources and releases them asynchronously in LIFO order.
- `DisposableMap` owns resources whose lifetime follows stable keys.
- `toDisposable()` adapts one cleanup callback to `IDisposable`.

Public ownership inputs should accept the standard `Disposable` protocol where appropriate, while project APIs that create synchronous resources should return `IDisposable` so callers may use either `.dispose()` or `using`.

## Ownership rules

Register a resource immediately after creating it:

```ts
class TitlebarPart extends Disposable {
	private readonly listener = this._register(titleService.onDidChange(() => this.render()));
}
```

Use `toDisposable()` when cleanup is a callback or when an API returns a value whose lifetime must be tied to an owner:

```ts
this._register(toDisposable(() => element.remove()));
```

Use `using` for lexical, short-lived ownership:

```ts
function performOperation(): void {
	using subscription = service.subscribe(listener);
	using lock = acquireLock();
	doWork();
}
```

When inheritance is unavailable, compose with a `DisposableStore` and register it as part of the class's disposal protocol. Do not override `Disposable.dispose()` or `[Symbol.dispose]()` merely to forward to the store.

Disposal is idempotent. A disposed store rejects new resources with `ReferenceError` and does not take ownership of the rejected resource; `MutableDisposable.value = resource` is a no-op after the mutable object is disposed and likewise leaves the caller responsible for `resource`.

## Electron boundary

Electron `contextBridge` cannot carry Symbol-keyed properties. A preload API therefore returns a string-keyed `DisposableHandle` containing only `dispose()`. This is a serialization-boundary type, not the local lifecycle protocol; adapt it to `IDisposable` with `toDisposable()` when renderer code needs to transfer the handle into a local owner.

Do not create general-purpose adapters elsewhere. Standard `Disposable` structural typing already provides local interoperability.

## Diagnostics

`DisposableTracker` is an opt-in development and test diagnostic. It records creation stacks and owner-child relationships, rejects multiple owners and ownership cycles, and can assert that a completed scope has no live resources:

```ts
const tracker = new DisposableTracker();
using tracking = installDisposableTracker(tracker);

const store = new DisposableStore();
store.add(service.subscribe(listener));
store.dispose();

tracker.assertNoLeaks();
```

Only one tracker is installed per JavaScript realm. Tracking is disabled when no tracker is installed, so production lifecycle correctness must never depend on it.

The `IDisposableTracker` contract, tracker slot, notification hooks, stack collection, ownership graph, and leak reporting are all owned by `lifecycle.ts`; production lifecycle correctness remains independent of whether a tracker is installed.

## Review rules

- Register a newly created resource immediately with `_register()`, `add()`, a `MutableDisposable`, or `using`.
- Do not discard a returned `IDisposable` unless the API explicitly documents process-lifetime ownership.
- Do not register one resource with multiple owners.
- Use `clear()` only for a real clear-and-rebuild lifecycle; use `clearAndLeak()` only when ownership intentionally transfers.
- Cleanup callbacks must tolerate repeated public disposal, even though the standard stacks already guard their own state.
- A synchronous owner must not hide unfinished asynchronous cleanup.
- Keep `AbortSignal` cancellation separate from resource disposal.
- Add a semantic test whenever a new resource container or ownership pattern is introduced.
