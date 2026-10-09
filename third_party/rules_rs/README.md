# `rules_rs` pin

The repository pins `rules_rs 0.0.96` through the archive override in the root
[`MODULE.bazel`](../../MODULE.bazel). The local patches are:

- `module_dot_bazel_version.patch`, which preserves module version metadata
  when the archive override bypasses the Bazel Central Registry patch set.
- `windows_gnullvm_exec_triples.patch`, which makes Windows Rust host tools use
  the same gnullvm ABI as the repository's hermetic LLVM/MinGW C++ toolchain.
  This is required for `rustc` to load proc-macro DLLs and link Bazel host tools
  without relying on an installed MSVC SDK. Because upstream places Cargo and
  rustc in separate repositories while gnullvm Cargo dynamically loads the
  matching `libunwind.dll`, the patch also merges the rustc runtime component
  into Cargo's repository. This keeps `cargo metadata` working when a manifest
  change reruns the crate extension. Remove the patch when `rules_rs` can select
  the Windows execution ABI and assemble its runtime DLLs from platform constraints.

The `rules_rust.patch` extension separately applies `rust_macos_rtlib.patch` to
the pinned `rules_rust` archive. It removes the C/C++ toolchain's redundant
`-rtlib=compiler-rt` selector from macOS Rust linker arguments. Rust disables
automatic default libraries, and Darwin already defaults to compiler-rt; the
explicit runtime archive remains linked. C/C++ actions and other target platforms
retain their existing arguments. Remove this patch when upstream filters the
selector at the Rust link boundary.

`rust_unwind_link_flags.patch` applies the same boundary rule to Linux Rust
links: remove `--unwindlib=none`, which Clang cannot consume once rustc passes
`-nodefaultlibs`. Explicit runtime inputs, C/C++ links and Cargo build-script
linker discovery keep their existing behavior. Remove this patch when upstream
filters the unused selector from Rust link arguments. The local Linux x64 V8
source probe exercises a real Rust executable link through this boundary:

```bash
bazel test //crates/v8-poc:v8-poc-unit-tests --config=v8-source --platforms=@llvm//platforms:linux_amd64_gnu.2.28 --test_arg=--test-threads=1
```

Verify this patch with:

```bash
bazel test //ash-rs/test-binary-support:test-binary-support-unit-tests //ash-rs/test-binary-support:roles-tests //ash-rs/mxc-sandbox:pty-tests
```

The Cargo graph intentionally has one root workspace. `rules_rs` therefore sees
`app`, its direct child crates, and `ash-rs/*` in one `cargo metadata` result. App-owned
and shared crates resolve to the same `@crates` hub; no cross-workspace metadata
bridge or duplicate product hub is required.

Verify the integration from the repository root:

```bash
bazel query //app-rs:app
bazel build //app-rs:app_sources
bazel test //app-rs:app_ci
```

If a newer rules_rs release is adopted, first remove the archive override in a
throwaway change and run the same graph checks. Keep a local patch only when an
upstream behavior is still required by this repository and document its exact
ownership here.
