"""Expose the same locked grammar archives to Bazel's Rust dependency graph."""

def _bundle_impl(ctx):
    ctx.download_and_extract(url = ctx.attr.url, sha256 = ctx.attr.sha256)
    manifest = json.decode(ctx.read("lib/bundle.json"))
    if manifest["target"] != ctx.attr.target or manifest["version"] != ctx.attr.version or manifest["sourceLockSha256"] != ctx.attr.source_digest:
        fail("Grammar bundle identity mismatch")
    library = "ash_grammars.lib" if "windows-msvc" in ctx.attr.target else "libash_grammars.a"
    ctx.file("BUILD.bazel", """load("@rules_cc//cc:defs.bzl", "cc_import")
cc_import(
    name = "library",
    static_library = "lib/%s",
    visibility = ["//visibility:public"],
)
""" % library)
    return ctx.repo_metadata(reproducible = True)

_bundle = repository_rule(
    implementation = _bundle_impl,
    attrs = {
        "url": attr.string(mandatory = True),
        "sha256": attr.string(mandatory = True),
        "source_digest": attr.string(mandatory = True),
        "target": attr.string(mandatory = True),
        "version": attr.string(mandatory = True),
    },
)

def _grammars_impl(ctx):
    lock = json.decode(ctx.read(Label("//third_party/ash-grammars:runtime-lock.json")))
    for target, artifact in lock["targets"].items():
        _bundle(
            name = "ash_grammars_" + target.replace("-", "_"),
            url = "https://github.com/chogng/ash-grammars/releases/download/v%s/%s" % (lock["version"], artifact["name"]),
            sha256 = artifact["sha256"],
            source_digest = lock["sourceLockSha256"],
            target = target,
            version = lock["version"],
        )
    return ctx.extension_metadata(reproducible = True)

grammars = module_extension(implementation = _grammars_impl)
