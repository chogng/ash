"""Bazel definitions for the app application workspace."""

load("@crates//:defs.bzl", "aliases", "all_crate_deps")
load("@rules_rust//rust:defs.bzl", "rust_binary", "rust_library", "rust_test")

def app_rust_library(
        name,
        crate_name,
        package_name,
        crate_root = "src/lib.rs",
        crate_features = [],
        data = [],
        source_files = [],
        source_globs = ["src/**/*.rs"],
        target_compatible_with = [],
        unit_tests = False):
    """Defines a app-owned Cargo library with metadata-derived dependencies.

    `package_name` is the Cargo workspace package path used by rules_rs. Keeping
    it explicit makes the Bazel target independent of the BUILD file directory.
    """
    rust_library(
        name = name,
        aliases = aliases(package_name = package_name),
        crate_name = crate_name,
        crate_root = crate_root,
        crate_features = crate_features,
        compile_data = data,
        deps = all_crate_deps(package_name = package_name),
        edition = "2024",
        srcs = native.glob(
            source_globs,
            exclude = ["src/main.rs", "src/bin/**/*.rs"],
        ),
        target_compatible_with = target_compatible_with,
        visibility = ["//visibility:public"],
    )

    if unit_tests:
        rust_test(
            name = name + "-unit-tests",
            crate = ":" + name,
            crate_features = crate_features,
            data = data,
            deps = all_crate_deps(
                package_name = package_name,
                normal = True,
                normal_dev = True,
            ),
            target_compatible_with = target_compatible_with,
        )

    native.filegroup(
        name = name + "_sources",
        srcs = native.glob(source_globs + ["Cargo.toml"]) + source_files,
        visibility = ["//visibility:public"],
    )

def app_rust_binary(
        name,
        crate_name,
        package_name,
        crate_root,
        deps = [],
        data = [],
        source_globs = ["src/**/*.rs"]):
    """Defines the app binary from the root workspace dependency graph."""
    rust_binary(
        name = name,
        crate_name = crate_name,
        compile_data = data,
        crate_root = crate_root,
        deps = all_crate_deps(package_name = package_name) + deps,
        edition = "2024",
        srcs = native.glob(source_globs),
        visibility = ["//visibility:public"],
    )
