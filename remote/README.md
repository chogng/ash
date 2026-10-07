# Remote distribution

`package.json` owns the supported SSH target platforms and the requirement to
bundle Node. Build the complete distribution from the repository root:

```sh
just remote-package --target aarch64-apple-darwin --package-dir dist/ash-remote
```

[`build/remote.py`](../build/remote.py) reads this declaration before compiling or
downloading anything. Unsupported targets and host-provided Node are rejected.
The entrypoint reuses the App Server package builder and
[`build/lib/package-layout.json`](../build/lib/package-layout.json), so Remote receives the same
complete package and integrity checks as other hosts. Service implementations
remain in `crates/remote-server`, `crates/app-server`, and their shared domains.

This is a product package declaration, not an additional npm workspace. Node and
tool versions remain owned by their existing `third_party` locks; Cargo
dependencies remain in the root workspace. No second dependency lock is needed.

The installer consumes a rootless `tar.gz` containing this package. The build
entrypoint assembles the directory; production Remote catalog publication is
still pending. Installation, compatibility checks, activation and rollback are
described in [`docs/remote-development.md`](../docs/remote-development.md).
