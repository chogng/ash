# Shared JavaScript extension runtime

Node, the optional Rust/V8 extension host and trusted browser Workers consume
these product-owned runtime resources. They remain independent of the optional
V8 executable's source directory:

- `ash.js` implements the Ash author API bound to `@ash/sdk`, including commands,
  documents, configuration, language, task, debug, terminal, speech and SCM providers.
  Authorized workspace UTF-8 reads use the Rust filesystem owner.
  `ExtensionContext.storage.get/update` uses the private, host-bound CoreService profile state
  contract for individual key reads and atomic writes. It retains
  no value cache and never chooses another package or profile namespace.
- `host.mjs` owns callback registration, activation, cancellation and disposal.
- `scm.js` provides the Ash SCM bridge.
- `node.mjs` binds the Node/Electron runtime to Host RPC and resolves `@ash/sdk`
  for explicitly admitted `api: ash` extensions. Other author modules are rejected.

The package assembler copies these runtime resources, renaming `ash.js` to `ash.mjs`.
Node, browser and optional V8 launchers bind the same public API to each admitted
extension instance. The runtime package exposes domain operations; transport identities
and generic backend connections remain private to the host.
V8-specific CommonJS loading, memory limits and isolation stay in
[`crates/external-js-ext`](../../crates/external-js-ext/README.md).

Run the Node process contract tests with:

```sh
node --test resources/extension-host/node.test.mjs
```

The public author package is [`sdk/typescript`](../../sdk/typescript/README.md).
Ash capability and permission boundaries are documented in
[`docs/editor-extensions.md`](../../docs/editor-extensions.md#运行时职责与-ash-契约).
Shared editor internals and process supervision retain their existing owners.

`ExtensionContext.secrets` uses private host-bound calls for get/store/delete.
The existing profile SecretStore owns persistence; the SDK cannot choose product keys,
another extension namespace or a backend.
Calls retain cancellation, deadline and exact-instance admission; retirement suppresses late
results and never replays writes. UTF-8 values are limited to 64 KiB and keys to 256 bytes.
Standalone Worker secrets require an authorized backend and are currently unavailable.
