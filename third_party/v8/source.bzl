"""Keep Chromium's C++ configuration inside the V8 archive dependency closure."""

def _source_config_impl(_settings, _attr):
    return {
        "@//:rusty_v8_custom_libcxx": True,
        "@v8//:v8_enable_pointer_compression": "True",
        "@v8//:v8_enable_sandbox": True,
        "@v8//:v8_use_rusty_v8_custom_libcxx": True,
        "//command_line_option:compilation_mode": "opt",
    }

_source_config = transition(
    implementation = _source_config_impl,
    inputs = [],
    outputs = [
        "@//:rusty_v8_custom_libcxx",
        "@v8//:v8_enable_pointer_compression",
        "@v8//:v8_enable_sandbox",
        "@v8//:v8_use_rusty_v8_custom_libcxx",
        "//command_line_option:compilation_mode",
    ],
)

def _archive_impl(ctx):
    # An attribute transition yields configured targets even for a single
    # branch. Forward the archive file; the crate build script consumes data.
    archive = ctx.attr.src[0][DefaultInfo].files
    if len(archive.to_list()) != 1:
        fail("V8 source build must produce exactly one static archive")
    return [DefaultInfo(files = archive)]

v8_source_archive = rule(
    implementation = _archive_impl,
    attrs = {
        "src": attr.label(mandatory = True, cfg = _source_config),
        "_allowlist_function_transition": attr.label(
            default = "@bazel_tools//tools/allowlists/function_transition_allowlist",
        ),
    },
)
