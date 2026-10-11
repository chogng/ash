# Standard extension example

This package uses `require('vscode')` and standard command/hover registration. Install this directory with Ash's local extension installer, then enable it and grant execution permissions. Run `ash.example.inspect` in an open workspace. The package manifest declares commands; `.ash-plugin/plugin.json` supplies the existing installation authority envelope.

No Ash TypeScript SDK is required. The product adapter translates supported APIs to the same Host RPC consumed by [Rust extensions](../../../sdk/rust/README.md). Unsupported VS Code APIs fail explicitly; see [current compatibility](../../../crates/external-js-ext/README.md).
