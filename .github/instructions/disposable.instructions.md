---
description: Guidelines for writing code using IDisposable
---

# Disposable API contracts

Ownership and primitive selection: [Disposable Ownership](typescript-coding-guidelines.instructions.md#disposable-ownership).

- `IDisposable` supports `dispose()` and `[Symbol.dispose]()`; disposal is synchronous and idempotent.
- `DisposableStore` releases resources in LIFO order. `clear()` releases current contents while leaving the store reusable; `isDisposed` denotes its terminal state.
- `MutableDisposable.value` replacement and clearing dispose the previous value; `clearAndLeak()` transfers it without disposal.
- `AsyncDisposableStore` releases synchronous and asynchronous resources asynchronously in LIFO order.
- Registration after disposal throws `ReferenceError` without taking ownership of the rejected resource.
- Tracker hooks reject multiple owners and cycles; they remain optional diagnostics, not lifecycle prerequisites.
