# `rules_rs` pin

The repository pins `rules_rs 0.0.96` through [Bazel Central Registry](https://github.com/bazelbuild/bazel-central-registry/blob/main/modules/rules_rs/0.0.96/source.json) in the root
[`MODULE.bazel`](../../MODULE.bazel). The registry owns the source URL, checksum
and module version metadata patch. `single_version_override` adds only the local
compatibility patch:

- `windows_gnullvm_exec_triples.patch`, which makes Windows Rust host tools use
  the same gnullvm ABI as the repository's hermetic LLVM/MinGW C++ toolchain.
  This is required for `rustc` to load proc-macro DLLs and link Bazel host tools
  without relying on an installed MSVC SDK. Remove the patch when `rules_rs` can
  select the Windows execution ABI from platform constraints.

GNU Cargo needs `libunwind.dll` beside its executable. Instead of patching the
split `rules_rs` Cargo repository, `MODULE.bazel` uses upstream
`rust_toolchain_tools_repository` to assemble the complete Rust 1.98.0 tools
layout for each Windows CPU. Bazel's `override_repo` substitutes those repositories
for the generated Cargo repositories, including the Cargo used by `cargo metadata`.
The existing default GNU compiler registrations remain owned by `rules_rs`.
This repository rule comes from the pinned `rules_rust` implementation; when
upgrading that pin or Rust, check the rule and both generated repository names.

The GNU Rust execution toolchains also require the gnullvm ABI constraint, so
they cannot be selected for an MSVC execution platform. Standalone Windows V8
hosts use upstream `rules_rust` MSVC repository sets and `rules_cc` Visual Studio
discovery. Their target and build-tool closures transition together; GNU callers
exchange protocol messages with the hosts instead of linking their libraries.
The hosts use upstream `rust_binary(platform=...)`; the MSVC platforms in
[`BUILD.bazel`](../../BUILD.bazel) carry their execution-platform, C++ toolchain
and Rust linker options through Bazel's `platform.flags`. There is no custom
transition or executable wrapper. These platforms require a Windows build host
with the matching SDK installed. Their C++ toolchain setting takes precedence
over caller-provided extra toolchains within the MSVC closure.
The small `rules_cc_windows_build_tools.patch` adds `vswhere -products *` so
standalone Visual Studio Build Tools installations are discovered too. Remove it
when upstream includes that option. Windows host builds need the matching MSVC
C++ and Windows SDK components installed, including ARM64 components for ARM64.

Verify the default GNU caller and MSVC host together on Windows:

```powershell
bazel build //:v8_host_binaries
bazel test //crates/code-mode-host:session-tests //crates/code-mode-host:client-tests
```

The clients use the shared Cargo/Bazel executable locator and upstream runfiles
manifest resolution. Windows tests do not need a physical runfiles symlink tree.

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

If a newer rules_rs release is adopted, first test its registry version without
the compatibility patch and run the same graph checks. Keep a local patch only
when an upstream behavior is still required by this repository and document its
exact ownership here.
