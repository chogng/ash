# Rust language support

This built-in extension contributes Rust language configuration, syntax resources and the
`ashLanguageServers` version 1 acquisition declaration in `package.json`.

The declaration owns the `rust-analyzer` identity, Rust route, `--version` probe,
`RUSTUP_AUTO_INSTALL=0` environment, Cargo workspace marker and exact official release assets.
Update the six upstream asset URLs, versions, sizes and SHA-256 digests together.

The host uses the existing frozen extension catalog, profile enablement, LSP supervisor and
package store. It probes local executables only on Rust demand and acquires the pinned binary
when none works. A configured path is authoritative; disabling this extension or the server
prevents acquisition. The host holds the package lease until the language server stops.
The Rust toolchain (`cargo` and `rustc`) remains user managed.

No separate extension executable or custom RPC is needed for this declarative adapter.
Arbitrary executable extension logic continues to use the public Host RPC and Rust SDK.
