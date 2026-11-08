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

def _source_file_impl(ctx):
    # The archive and bindgen must see the same V8 and libc++ configuration.
    files = ctx.attr.src[0][DefaultInfo].files
    if len(files.to_list()) != 1:
        fail("Expected exactly one V8 source build output")
    return [DefaultInfo(files = files)]

v8_source_file = rule(
    implementation = _source_file_impl,
    attrs = {
        "src": attr.label(mandatory = True, cfg = _source_config),
        "_allowlist_function_transition": attr.label(
            default = "@bazel_tools//tools/allowlists/function_transition_allowlist",
        ),
    },
)
