---
description: Ash TypeScript formatting, naming, disposal ownership, functions, and types.
applyTo: "**/src/ash/**"
---

# TypeScript Coding Guidelines

## Formatting

- Use the repository-pinned `bun fmt` through `pnpm format:ts:fix [file|directory ...]`; `.prettierrc.toml` owns tabs, single quotes, semicolons, 200-column wrapping and trailing commas. Preserve multiline object literals; let the formatter wrap imports, signatures and expressions. Do not maintain competing manual layout rules or reformat unrelated files.
- Always use braces with the opening brace on the same line.

## Naming

- PascalCase: classes, interfaces, types, enums and enum members. camelCase: functions, methods, properties, parameters and locals.
- Boolean names normally start with `is`, `has`, `can` or `should`.
- Event handlers use `handle*`; events use `onDid*`.
- Reuse a local VS Code counterpart's filename only when responsibilities match. Single-module tests use the module name plus `.test.ts`; independent scenarios may add a descriptive dot suffix. Do not claim a local naming choice is VS Code alignment.

## Class Members

- Declare visibility explicitly, defaulting to `private`. Use `protected` only for a subclass API.
- Do not prefix private or protected members with `_`, except backing members sharing a public semantic name.
- Constructors omit redundant `public`; use `private` or `protected` to restrict construction.
- Use `readonly` for field references assigned once. Access owned state through `this`; keep inputs and intermediates local.

## Disposable Ownership

- `Disposable` retains protected `_store` and `_register()` names for API compatibility, an exception to underscore naming.
- Stateful leaf handles extend `AbstractDisposable` and implement `disposeCore`; callback-only cleanup uses `toDisposable`.
- Components aggregating listeners, child components, timers or replaceable resources extend `Disposable` and register resources immediately with `_register()`.
- Do not allocate a `DisposableStore` or extend `Disposable` solely to delegate disposal to one implementation resource.
- Use `MutableDisposable` for one replaceable resource and `DisposableMap` for resources owned by stable keys, rather than hand-written replacement and disposal loops.
- Use `Disposable.None` or `noneDisposable` and `noEvent` for inert boundaries.
- Use inherited `isDisposed` and `assertNotDisposed()` instead of shadow fields or guards. Separate `failed`, `closed` or protocol-terminal state is valid only when the object becomes unusable before disposal.
- Implement cleanup through protected APIs; do not override public disposal entrypoints.
- Keep distinct graceful async `close()` and forced sync `dispose()` protocols in their domain; do not merge them into a generic base.
- Without inheritance, use an owned `DisposableStore`; `clear()` is for clear-and-rebuild lifecycles, not hand-maintained cleanup arrays.

## Functions and Types

- Named functions and class methods declare return types.
- Use guard clauses; omit `else` after a terminal branch. Prefer `async`/`await` over `.then()` chains and declarations for exported top-level functions.
- Avoid nested ternaries and condition spreads.
- Constructors must not perform async work, full rendering, service lookup or overridable calls.
- Do not extract private methods merely to label consecutive statements.
- Use `import type` for entirely type-only imports.
- Shared business states, error codes and modes use string enums with explicit values; variants with different data use discriminated unions.
- Replace ambiguous positional booleans or `undefined` arguments with enums, named methods or options fields.
- Use `const` unless reassigned, `let` when reassigned, and never `var`.
- JSDoc uses one or two short sentences and does not restate the signature.
