# Shared JavaScript extension runtime

Node, the optional Rust/V8 extension host and trusted browser Workers consume
these product-owned runtime resources. They remain independent of the optional
V8 executable's source directory:

- `vscode.js` implements the supported VS Code API facade.
- `host.mjs` owns callback registration, activation, cancellation and disposal.
- `scm.js` provides the Ash SCM bridge.
- `node.mjs` binds the standard Node/Electron runtime to Host RPC.

The package assembler copies only those four runtime files. Browser builds bundle
the facade and its supporting modules; the optional V8 host embeds them at compile
time. V8-specific CommonJS loading, memory limits and isolation stay in
[`crates/external-js-ext`](../../crates/external-js-ext/README.md).

Run the Node process contract tests with:

```sh
node --test resources/extension-host/node.test.mjs
```

Compatibility and permission boundaries are documented in
[`docs/editor-extensions.md`](../../docs/editor-extensions.md#运行时职责与兼容契约).
