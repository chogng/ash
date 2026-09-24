---
name: rust-build-perf
description: Diagnose and improve Rust/Cargo compile and rebuild times. Use for slow local builds, CI build hotspots, or proposed compiler and Cargo setting changes.
---

# Rust build performance

Improve the build loop the developer actually uses. Establish which command, package or executable, profile, target, features, and edit pattern are slow before changing code or Cargo settings. Keep measurement history in [the build document](../../../docs/build.md#历史测量与适用范围); this skill is the repeatable investigation procedure.

## Investigate

1. Read the existing [build commands and measurement limits](../../../docs/build.md#构建测量), [Rust dependency and build rules](../../../.github/instructions/rust.instructions.md#dependencies-and-build-costs), and [Rust validation rules](../../../.github/instructions/rust-testing.instructions.md). Check prior reports under `.build/build-health/` and the command used in the reported workflow. Measure the package and end-to-end build path that can demonstrate the complaint; a package result alone does not establish a speedup for the whole build.
2. Capture a comparable baseline before editing. Fetch locked dependencies, avoid other Rust builds during measurement, and use `just bench-build <package> --profile <profile> --jobs <count>` for at least three clean, unchanged, and timestamp-touch runs of a package's default-feature build. The command saves wall time, maximum RSS, artifact sizes, logs, and Cargo timings. For feature-specific or multi-package workflows, also measure the actual build command. Keep the same machine, toolchain, target, features, flags, job count, and cache conditions for the candidate. Never clear the shared `.build/cargo` directory to manufacture a cold build.
3. Read Cargo timings as a timeline: find the units on the critical path, including build scripts, proc macros, Rust compilation, and linking. A large summed crate time is not necessarily the wall-time bottleneck. Trace an unexpected dependency with `cargo tree --locked --offline -p <package>` and `cargo tree --locked --offline -i <dependency>`. Check the actual build profile and feature graph before attributing a slowdown to code generation.
4. Choose one change based on the measured cause:

   | Evidence | Change to evaluate |
   | --- | --- |
   | A small shared type pulls a service and its heavy dependencies into many consumers | Put the type in the appropriate contract owner and make consumers depend on that contract. |
   | Many instantiations of substantial generic or macro-generated work dominate one crate | Share the type-independent work; verify behavior and runtime cost. |
   | A sequential workflow recompiles the same graph under different profiles or targets | Align the build invocations where their requirements allow it. |
   | Compilation or linking dominates after dependency and source analysis | Test a profile or linker candidate on the real build and edit loop. |

   Treat settings from other codebases as hypotheses. Measure any `codegen-units`, LTO, optimization, or debug setting change in this repository before adopting it: a prior global `4 CGU + ThinLTO` trial improved one cold build but severely slowed a release edit rebuild. Preserve the current macOS unwind constraints.
5. Change one cause at a time. Compare matched before and after runs for clean, unchanged, and touch builds; report medians, critical-path changes, RSS, and artifacts separately. A touch run proves invalidation, not feature-edit speed. For a claim about edit-debug iteration, use a controlled representative source edit with reusable output, confirm the intended units actually recompiled in Cargo output, and repeat under comparable load. Reject runs incorrectly marked `Fresh` or disturbed by other builds.
6. Validate the owning package and affected consumers with the smallest relevant `just check`, `just test`, normal build, and `just rust-warnings` commands. For manifest or lockfile changes run `just dependencies`; for protocol changes regenerate and check the TypeScript client as required by the Rust validation rules. Test the complete build when making a claim about it. Report the measured improvement or measured rejection, the scenario it covers, and any unmeasured build or platform scope.

## Example

If a protocol package imports a service only for one data type, and that service brings HTTP/TLS into the compile path, move the type to an appropriate contract crate. If the hotspot is repeated generic instantiation, share the type-independent work instead. These causes call for different changes; neither alone justifies a global Cargo profile change. See the [measured examples and their limits](../../../docs/build.md#历史测量与适用范围).
