---
name: update-v8-version
description: Update Ash's pinned V8 inputs, validate independent dependency production, or diagnose V8 artifact failures.
---

# Update V8 inputs

## Ownership

`chogng/ash-rusty-v8` owns source production, patches, producer toolchains, native probes and releases. Ash consumes immutable archive/binding pairs and owns product runtime policy. Do not restore a source producer in Ash or check out Ash from the dependency producer.

## Producer changes

1. Work in the independent repository. `upstream-source-lock.json` pins the upstream revision, compiler, Windows tools and source backports. Its `Cargo.toml`, `Cargo.lock`, `MODULE.bazel`, `MODULE.bazel.lock` and `third_party/v8/` declarations must agree with that pin.
2. Keep the standalone Cargo workspace restricted to the artifact probe. Product crates, app-server APIs and product runtime implementations stay in Ash.
3. Run the producer's release/smoke Python contracts and metadata command. Validate changed build behavior from a directory without an Ash checkout or parent Cargo/Bazel configuration.
4. Use the independent source workflow for Linux/Windows recipe checks. Version or native-input changes require the independent full release matrix, including native execution of cross-linked ARM64 probes and exact archive/binding provenance verification.
5. Publish immutable dependency artifacts through the independent release workflow. Keep existing release assets unchanged. A producer validation result is distinct from publishing or product adoption.

## Ash adoption

1. Keep one exact crate version in root `Cargo.toml` and `Cargo.lock`. Adopt the verified candidate `third_party/v8/runtime-lock.json` and synchronize the header/archive/binding URLs and checksums in `MODULE.bazel`.
2. Run `python3 -B -m build.lib.v8 --check`, the affected Python acquisition tests and the actual Cargo/Bazel consumer targets. Keep archive/binding target and feature settings matched, including Windows MSVC and Linux musl.
3. Product CI validates acquisition, runtime policy and integration. It must not build V8 source or dispatch dependency production as a side effect.
4. Retain runtime mitigations while any supported source, mirror or explicit override can bypass the upstream fix. Sandbox configuration checks alone do not prove a compiler regression is repaired.

## Failure reporting

Identify the producer or consumer boundary, target, immutable version and first actionable error. Use the corresponding native build or consumer probe to verify the fix. Distinguish local checks, hosted validation, publication and adoption; build analysis and metadata checks do not prove native execution.
