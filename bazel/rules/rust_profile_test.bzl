"""Analysis-only checks for the generated Rust dependencies' test profiles."""

_PER_CRATE_RUSTC_FLAG = "@rules_rust//rust/settings:experimental_per_crate_rustc_flag"

_RustProfileInfo = provider(
    fields = {
        "actions": "Actions registered by the actual crate target, not its dependencies.",
        "compilation_mode": "The crate target's effective compilation mode.",
        "crate_root": "The generated crate target's root source path.",
        "label": "The actual crate target's label, after resolving aliases.",
        "skip_per_crate_rustc_flags": "Whether the generated target trims per-crate flags.",
    },
)

def _rust_profile_aspect_impl(target, ctx):
    return [_RustProfileInfo(
        actions = target.actions,
        compilation_mode = ctx.var["COMPILATION_MODE"],
        crate_root = ctx.rule.file.crate_root.path,
        label = target.label,
        skip_per_crate_rustc_flags = ctx.rule.attr.skip_per_crate_rustc_flags,
    )]

# Do not propagate to deps: only the real target behind the @crates alias may
# satisfy the assertions. No dependency's Rustc action can stand in for it.
_rust_profile_aspect = aspect(
    implementation = _rust_profile_aspect_impl,
    attr_aspects = [],
)

def _effective_opt_level(argv):
    """Return the last optimization level, as rustc does for repeated flags."""
    result = None
    for index, argument in enumerate(argv):
        if argument in ["-C", "--codegen"] and index + 1 < len(argv):
            value = argv[index + 1]
            if value.startswith("opt-level="):
                result = value[len("opt-level="):]
        elif argument.startswith("-Copt-level="):
            result = argument[len("-Copt-level="):]
        elif argument.startswith("--codegen=opt-level="):
            result = argument[len("--codegen=opt-level="):]
    return result

def _rust_profile_test_impl(ctx):
    target = ctx.attr.target_under_test
    # Analysis-test transitions expose their single configured target in a list;
    # the CI case has no transition so it retains the invocation's configuration.
    if type(target) == "list":
        if len(target) != 1:
            fail("expected exactly one configured crate, got {}".format(target))
        target = target[0]
    profile = target[_RustProfileInfo]
    errors = []

    if profile.crate_root != ctx.attr.expected_crate_root:
        errors.append("crate root: expected {}, got {}".format(
            ctx.attr.expected_crate_root,
            profile.crate_root,
        ))
    if profile.compilation_mode != ctx.attr.expected_compilation_mode:
        errors.append("compilation mode: expected {}, got {}".format(
            ctx.attr.expected_compilation_mode,
            profile.compilation_mode,
        ))
    if profile.skip_per_crate_rustc_flags != ctx.attr.expected_skip_per_crate_rustc_flags:
        errors.append("skip_per_crate_rustc_flags: expected {}, got {}".format(
            ctx.attr.expected_skip_per_crate_rustc_flags,
            profile.skip_per_crate_rustc_flags,
        ))

    rustc_actions = [action for action in profile.actions if action.mnemonic == "Rustc"]
    if len(rustc_actions) != 1:
        errors.append("expected exactly one Rustc action, got {}; action mnemonics: {}".format(
            len(rustc_actions),
            [action.mnemonic for action in profile.actions],
        ))
    for action in rustc_actions:
        argv = action.argv
        if profile.crate_root not in argv:
            errors.append("Rustc argv does not compile crate root {}".format(profile.crate_root))
        actual_opt_level = _effective_opt_level(argv)
        if actual_opt_level != ctx.attr.expected_opt_level:
            errors.append("effective opt-level: expected {}, got {}".format(
                ctx.attr.expected_opt_level,
                actual_opt_level,
            ))
        if errors:
            errors.append("Rustc argv: {}".format(argv))

    return [AnalysisTestResultInfo(
        success = not errors,
        message = "{}: {}\n{}".format(ctx.label, profile.label, "\n".join(errors)) if errors else "",
    )]

def _make_rust_profile_test(settings = {}):
    target_kwargs = {}
    if settings:
        target_kwargs["cfg"] = analysis_test_transition(settings = settings)
    return rule(
        implementation = _rust_profile_test_impl,
        attrs = {
            "expected_compilation_mode": attr.string(mandatory = True),
            "expected_crate_root": attr.string(mandatory = True),
            "expected_opt_level": attr.string(mandatory = True),
            "expected_skip_per_crate_rustc_flags": attr.bool(mandatory = True),
            "target_under_test": attr.label(
                mandatory = True,
                aspects = [_rust_profile_aspect],
                **target_kwargs
            ),
        },
        analysis_test = True,
        test = True,
    )

# The CI check must see the caller's real --config=ci flags. Synthesizing those
# flags in a transition would hide a broken .bazelrc entry or crate-root filter.
_ci_rust_profile_test = _make_rust_profile_test()

_fastbuild_rust_profile_test = _make_rust_profile_test({
    "//command_line_option:compilation_mode": "fastbuild",
    _PER_CRATE_RUSTC_FLAG: [],
})

_opt_rust_profile_test = _make_rust_profile_test({
    "//command_line_option:compilation_mode": "opt",
    _PER_CRATE_RUSTC_FLAG: [],
})

# An empty prefix matches every crate. A non-sha2 generated dependency must
# still trim this flag, proving the annotation did not disable trimming globally.
_trimmed_dependency_rust_profile_test = _make_rust_profile_test({
    "//command_line_option:compilation_mode": "fastbuild",
    _PER_CRATE_RUSTC_FLAG: ["@-Copt-level=1"],
})

def rust_test_profile_contract_suite(name):
    """Check generated dependency actions without compiling or running Rust.

    Args:
        name: Name of the test suite, which must be run with --config=ci.
    """
    sha2 = {
        "target_under_test": "@crates//:sha2",
        "expected_crate_root": "external/rules_rs++crate+crates__sha2-0.10.9/src/lib.rs",
        "expected_skip_per_crate_rustc_flags": False,
        "size": "small",
        "tags": ["manual"],
    }
    _ci_rust_profile_test(
        name = name + "-sha2-ci",
        expected_compilation_mode = "fastbuild",
        expected_opt_level = "1",
        **sha2
    )
    _fastbuild_rust_profile_test(
        name = name + "-sha2-fastbuild",
        expected_compilation_mode = "fastbuild",
        expected_opt_level = "0",
        **sha2
    )
    _opt_rust_profile_test(
        name = name + "-sha2-opt",
        expected_compilation_mode = "opt",
        expected_opt_level = "3",
        **sha2
    )
    _trimmed_dependency_rust_profile_test(
        name = name + "-other-dependency-trims-flags",
        target_under_test = "@crates//:cfg-if-1.0.4",
        expected_crate_root = "external/rules_rs++crate+crates__cfg-if-1.0.4/src/lib.rs",
        expected_compilation_mode = "fastbuild",
        expected_opt_level = "0",
        expected_skip_per_crate_rustc_flags = True,
        size = "small",
        tags = ["manual"],
    )
    # The incoming-config case requires --config=ci. CI names this suite
    # explicitly; an ordinary unconfigured `bazel test //...` must not select it.
    native.test_suite(
        name = name,
        tags = ["manual"],
        tests = [
            ":" + name + "-sha2-ci",
            ":" + name + "-sha2-fastbuild",
            ":" + name + "-sha2-opt",
            ":" + name + "-other-dependency-trims-flags",
        ],
    )
