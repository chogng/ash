"""Shared Bazel definitions for Rust crates in the Ash workspace."""

load("@crates//:data.bzl", "DEP_DATA")
load("@crates//:defs.bzl", "all_crate_deps")
load("@rules_rust//rust:defs.bzl", "rust_binary", "rust_library", "rust_test")

def _crate_aliases(include_dev = False):
    # rules_rust aliases are dependency labels. Passing every Cargo alias also
    # adds dev-only edges to libraries, creating cycles that Cargo never has.
    data = DEP_DATA.get(native.package_name(), {})
    aliases = data.get("aliases", {})
    common = list(data.get("deps", []))
    platforms = dict(data.get("deps_by_platform", {}))
    if include_dev:
        common += data.get("dev_deps", [])
        for platform, deps in data.get("dev_deps_by_platform", {}).items():
            platforms[platform] = platforms.get(platform, []) + deps
    result = {
        platform: {label: alias for label, alias in aliases.items() if label in common + deps}
        for platform, deps in platforms.items()
    }
    result["//conditions:default"] = {label: alias for label, alias in aliases.items() if label in common}
    return select(result)

def ash_rust_crate(name, crate_name, data = [], crate_features = [], extra_aliases = {}, extra_deps = [], test_env_inherit = [], test_env = {}, testonly = False):
    """Defines a Cargo library crate and its unit-test target.

    The crate's dependencies come from the workspace Cargo.lock through the
    generated `@crates` repository, so Bazel resolves the same dependency graph
    as Cargo. Each package must invoke this macro from its own BUILD file.
    """
    srcs = native.glob(
        ["src/**/*.rs"],
        exclude = ["src/main.rs"],
    )

    rust_library(
        name = name,
        testonly = testonly,
        aliases = _crate_aliases() | extra_aliases,
        crate_name = crate_name,
        crate_features = crate_features,
        compile_data = data,
        deps = all_crate_deps() + extra_deps,
        edition = "2024",
        rustc_env_files = ["//:workspace-version-env"],
        srcs = srcs,
        visibility = ["//visibility:public"],
    )

    rust_test(
        name = name + "-unit-tests",
        aliases = _crate_aliases(include_dev = True) | extra_aliases,
        crate = ":" + name,
        # rust_test recompiles the crate; feature flags must match its library.
        crate_features = crate_features,
        data = data,
        env = test_env,
        env_inherit = test_env_inherit,
        deps = all_crate_deps(
            normal = True,
            normal_dev = True,
        ) + extra_deps,
        rustc_env_files = ["//:workspace-version-env"],
    )

def ash_rust_binary(name, crate_name, crate_root, deps, data = [], extra_aliases = {}):
    """Defines a Cargo binary using the lockfile-derived dependency graph.

    Callers provide the package library in `deps` when the binary imports it.
    This keeps the dependency edge explicit and mirrors Cargo's package layout.
    """
    rust_binary(
        name = name,
        aliases = _crate_aliases() | extra_aliases,
        crate_name = crate_name,
        compile_data = data,
        crate_root = crate_root,
        deps = all_crate_deps() + deps,
        edition = "2024",
        rustc_env_files = ["//:workspace-version-env"],
        srcs = native.glob(["src/**/*.rs"]),
        visibility = ["//visibility:public"],
    )
