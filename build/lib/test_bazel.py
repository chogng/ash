"""Keep first-party Cargo dependency declarations consistent with Bazel."""

import ast
from pathlib import Path
import tempfile
import textwrap
import tomllib
from types import SimpleNamespace
import unittest


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
LIBRARY_RULES = {
    "ash_rust_crate",
    "app_rust_library",
    "rust_library",
    "rust_proc_macro",
    "alias",
}
BINARY_RULES = {"ash_rust_binary", "app_rust_binary", "rust_binary"}


def workspace_manifests(root):
    workspace = tomllib.loads((root / "Cargo.toml").read_text(encoding="utf-8"))[
        "workspace"
    ]
    members = {
        (root / member).resolve(): tomllib.loads(
            (root / member / "Cargo.toml").read_text(encoding="utf-8")
        )
        for member in workspace["members"]
    }
    return workspace, members


def dependency_spec(root, member, workspace, name, spec):
    if not isinstance(spec, dict):
        return member, {}
    if not spec.get("workspace"):
        return member, spec
    inherited = workspace["dependencies"][name]
    if not isinstance(inherited, dict):
        return root, {}
    return root, {
        **inherited,
        **spec,
        # Cargo adds consumer features to workspace dependency features.
        "features": inherited.get("features", []) + spec.get("features", []),
    }


def literal_attribute(call, attribute, default, build_file):
    value = next((key.value for key in call.keywords if key.arg == attribute), None)
    if value is None:
        return default
    if isinstance(value, ast.Name):
        assignments = [
            statement.value
            for statement in ast.parse(build_file.read_text(encoding="utf-8")).body
            if isinstance(statement, ast.Assign)
            and any(
                isinstance(target, ast.Name) and target.id == value.id
                for target in statement.targets
            )
        ]
        if len(assignments) == 1:
            value = assignments[0]
    try:
        return ast.literal_eval(value)
    except (ValueError, TypeError) as error:
        raise AssertionError(
            f"{build_file}:{call.lineno}: {attribute} must be statically readable "
            "by the Cargo/Bazel declaration check"
        ) from error


def macro_required_argument_errors(root, build_file):
    """Read required parameters from the owned Rust macros, not a copied schema."""
    tree = ast.parse(build_file.read_text(encoding="utf-8"), filename=str(build_file))
    macros = {}
    for statement in tree.body:
        if not (
            isinstance(statement, ast.Expr)
            and isinstance(load := statement.value, ast.Call)
            and isinstance(load.func, ast.Name)
            and load.func.id == "load"
        ):
            continue
        label = ast.literal_eval(load.args[0])
        if label not in {"//:defs.bzl", "//app-rs:defs.bzl"}:
            continue
        package, filename = label.removeprefix("//").split(":", 1)
        source = root / package / filename
        definitions = {
            node.name: node
            for node in ast.parse(source.read_text(encoding="utf-8")).body
            if isinstance(node, ast.FunctionDef)
        }
        imports = {
            ast.literal_eval(arg): ast.literal_eval(arg) for arg in load.args[1:]
        }
        imports.update({key.arg: ast.literal_eval(key.value) for key in load.keywords})
        for local, original in imports.items():
            macros[local] = (source, definitions[original])
    errors = []
    for call in ast.walk(tree):
        if not (
            isinstance(call, ast.Call)
            and isinstance(call.func, ast.Name)
            and call.func.id in macros
        ):
            continue
        source, definition = macros[call.func.id]
        location = f"{build_file.relative_to(root)}:{call.lineno}: {call.func.id}"
        if any(isinstance(arg, ast.Starred) for arg in call.args) or any(
            key.arg is None for key in call.keywords
        ):
            errors.append(
                f"{location}: dynamic arguments cannot be checked against {source.relative_to(root)}"
            )
            continue
        parameters = [arg.arg for arg in definition.args.args]
        required = parameters[: len(parameters) - len(definition.args.defaults)]
        required += [
            arg.arg
            for arg, default in zip(
                definition.args.kwonlyargs, definition.args.kw_defaults
            )
            if default is None
        ]
        supplied = set(parameters[: len(call.args)]) | {
            key.arg for key in call.keywords
        }
        missing = [name for name in required if name not in supplied]
        if missing:
            errors.append(
                f"{location}: missing required arguments {missing!r} from {source.relative_to(root)}"
            )
    return errors


def build_targets(member, rules=LIBRARY_RULES):
    build_file = member / "BUILD.bazel"
    if not build_file.is_file():
        return {}
    tree = ast.parse(build_file.read_text(encoding="utf-8"), filename=str(build_file))
    # Parsing alone accepts repeated keywords, which clean textual merges can add.
    # Compile without executing so invalid BUILD declarations fail with their path.
    compile(tree, str(build_file), "exec")
    return {
        literal_attribute(node, "name", None, build_file): node
        for statement in tree.body
        if isinstance(statement, ast.Expr)
        and isinstance(node := statement.value, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id in rules
    }


def resolve_library(root, member, name):
    visited = set()
    while (member, name) not in visited:
        visited.add((member, name))
        build_file = member / "BUILD.bazel"
        call = build_targets(member).get(name)
        if call is None:
            raise AssertionError(f"{build_file}: missing library target {name!r}")
        if call.func.id != "alias":
            return build_file, call
        actual = literal_attribute(call, "actual", "", build_file)
        if actual.startswith(":"):
            name = actual[1:]
        elif actual.startswith("//"):
            package, _, target = actual[2:].partition(":")
            member = (root / package).resolve()
            name = target or member.name
        else:
            raise AssertionError(f"{build_file}: unsupported library alias {actual!r}")
    raise AssertionError(f"{build_file}: library alias cycle at {name!r}")


def dependency_contract_errors(root):
    """Check unconditional edges without guessing Cargo cfg resolution.

    rules_rs 0.0.96 workspace_dep_data emits path aliases from the package name
    (or explicit rename), not the dependency's lib.name. Our library/binary macros
    use those aliases; ash macros can override them with extra_aliases. Features
    are manual BUILD attributes even though from_cargo generates feature metadata.

    Check explicit features on normal, non-optional, non-target-specific edges.
    Defaults, feature forwarding, dev/build edges and conditional activation need
    the real Cargo/Bazel resolver; treating their union as required here would
    reject intentional feature variants such as voice-host and sprite.
    """
    workspace, members = workspace_manifests(root)
    errors = []
    for member, manifest in members.items():
        consumer = (member / "Cargo.toml").relative_to(root).as_posix()
        own_build = member / "BUILD.bazel"
        own_targets = build_targets(member, LIBRARY_RULES | BINARY_RULES)
        for own_target in own_targets.values():
            if own_target.func.id in {"app_rust_library", "app_rust_binary"}:
                package = literal_attribute(own_target, "package_name", None, own_build)
                if package != member.relative_to(root).as_posix():
                    errors.append(
                        f"{own_build.relative_to(root).as_posix()}: package_name "
                        f"{package!r} does not identify Cargo metadata path "
                        f"{member.relative_to(root).as_posix()!r} for {consumer}"
                    )
        for name, original in manifest.get("dependencies", {}).items():
            base, spec = dependency_spec(root, member, workspace, name, original)
            if "path" not in spec or spec.get("optional"):
                continue
            dependency = (base / spec["path"]).resolve()
            if dependency not in members:
                continue
            if not any(call.func.id != "alias" for call in own_targets.values()):
                raise AssertionError(
                    f"{own_build}: no statically readable Rust consumer target "
                    f"for {consumer} dependency {name!r}"
                )
            build_file, target = resolve_library(root, dependency, dependency.name)
            features = literal_attribute(target, "crate_features", [], build_file)
            missing = set(spec.get("features", [])) - set(features)
            if missing:
                errors.append(
                    f"{consumer}: dependency {name!r} requests features "
                    f"{sorted(missing)!r} missing from {build_file.relative_to(root).as_posix()} "
                    f"target {literal_attribute(target, 'name', None, build_file)!r} "
                    "crate_features"
                )

            dependency_manifest = members[dependency]
            package_name = dependency_manifest["package"]["name"]
            renamed = "package" in spec
            expected = (
                name
                if renamed
                else dependency_manifest.get("lib", {}).get("name", package_name)
            ).replace("-", "_")
            generated = name.replace("-", "_")
            label = "//" + dependency.relative_to(root).as_posix()
            for own_target in own_targets.values():
                rule = own_target.func.id
                if rule == "alias":
                    continue
                if rule in {"app_rust_library", "app_rust_binary"}:
                    actual = generated
                    overrides = {}
                elif rule in {"ash_rust_crate", "ash_rust_binary"}:
                    actual = generated
                    overrides = literal_attribute(
                        own_target, "extra_aliases", {}, own_build
                    )
                else:
                    default_name = literal_attribute(
                        target, "name", None, build_file
                    ).replace("-", "_")
                    actual = literal_attribute(
                        target, "crate_name", default_name, build_file
                    )
                    overrides = literal_attribute(own_target, "aliases", {}, own_build)
                actual = overrides.get(
                    label, overrides.get(label + ":" + dependency.name, actual)
                )
                if actual != expected:
                    errors.append(
                        f"{consumer}: dependency {name!r} imports {expected!r}, but "
                        f"{own_build.relative_to(root).as_posix()} target "
                        f"{literal_attribute(own_target, 'name', None, own_build)!r} "
                        f"aliases {label} as {actual!r}; dependency library is "
                        f"{(dependency / 'Cargo.toml').relative_to(root).as_posix()}"
                    )
    return errors


class BazelWorkspaceDependencyTests(unittest.TestCase):
    def test_cargo_path_dependencies_have_default_bazel_library_targets(self):
        workspace, members = workspace_manifests(REPOSITORY_ROOT)
        dependencies = set()
        for member, manifest in members.items():
            for section in [manifest, *manifest.get("target", {}).values()]:
                for kind in ("dependencies", "dev-dependencies", "build-dependencies"):
                    for name, spec in section.get(kind, {}).items():
                        base, spec = dependency_spec(
                            REPOSITORY_ROOT, member, workspace, name, spec
                        )
                        if "path" in spec:
                            dependency = (base / spec["path"]).resolve()
                            if dependency in members:
                                dependencies.add(dependency)

        self.assertTrue(dependencies)
        for dependency in sorted(dependencies):
            with self.subTest(package=dependency.relative_to(REPOSITORY_ROOT)):
                # rules_rs emits //path; Bazel expands it to //path:basename.
                resolve_library(REPOSITORY_ROOT, dependency, dependency.name)

    def test_cargo_dependency_aliases_and_direct_features_match_bazel(self):
        self.assertEqual([], dependency_contract_errors(REPOSITORY_ROOT))


class BazelMacroContractTests(unittest.TestCase):
    def test_workspace_builds_supply_required_macro_arguments(self):
        _, members = workspace_manifests(REPOSITORY_ROOT)
        errors = []
        for member in members:
            build_file = member / "BUILD.bazel"
            if build_file.is_file():
                errors.extend(
                    macro_required_argument_errors(REPOSITORY_ROOT, build_file)
                )
        self.assertEqual([], errors)

    def macro_calls(self, path, macro, **arguments):
        calls = []
        metadata_aliases = {
            "//provider": "metadata_name",
            "//test-provider": "test_name",
        }

        def aliases(package_name):
            self.assertEqual("fixture", package_name)
            return metadata_aliases

        # These macros are Python-compatible Starlark. Execute their real bodies;
        # only Bazel primitives are stubbed, so dropping alias/feature forwarding
        # or reversing an override fails without fetching a compiler toolchain.
        namespace = {
            "load": lambda *args: None,
            "DEP_DATA": {
                "fixture": {
                    "aliases": metadata_aliases,
                    "deps": ["//provider"],
                    "dev_deps": ["//test-provider"],
                }
            },
            "aliases": aliases,
            "all_crate_deps": lambda **kwargs: [],
            "select": lambda branches: branches["//conditions:default"],
            "native": SimpleNamespace(
                package_name=lambda: "fixture",
                glob=lambda *args, **kwargs: [],
                filegroup=lambda **kwargs: None,
            ),
            "rust_library": lambda **kwargs: calls.append(kwargs),
            "rust_binary": lambda **kwargs: calls.append(kwargs),
            "rust_test": lambda **kwargs: calls.append(kwargs),
        }
        source = REPOSITORY_ROOT / path
        exec(
            compile(source.read_text(encoding="utf-8"), str(source), "exec"), namespace
        )
        namespace[macro](name="fixture", crate_name="fixture", **arguments)
        return calls

    def test_app_library_and_binary_forward_metadata_aliases(self):
        for macro, arguments in (
            ("app_rust_library", {"crate_features": ["cloud"]}),
            ("app_rust_binary", {"crate_root": "src/main.rs"}),
        ):
            with self.subTest(macro=macro):
                calls = self.macro_calls(
                    "app-rs/defs.bzl", macro, package_name="fixture", **arguments
                )
                self.assertEqual(
                    {"//provider": "metadata_name", "//test-provider": "test_name"},
                    calls[0]["aliases"],
                )
                if "crate_features" in arguments:
                    self.assertEqual(["cloud"], calls[0]["crate_features"])

    def test_ash_library_and_binary_preserve_overrides_without_dev_only_edges(self):
        for macro, arguments in (
            ("ash_rust_crate", {"crate_features": ["cloud"]}),
            ("ash_rust_binary", {"crate_root": "src/main.rs", "deps": []}),
        ):
            with self.subTest(macro=macro):
                calls = self.macro_calls(
                    "defs.bzl",
                    macro,
                    extra_aliases={"//provider": "caller_name"},
                    **arguments,
                )
                self.assertEqual({"//provider": "caller_name"}, calls[0]["aliases"])
                if "crate_features" in arguments:
                    self.assertEqual(["cloud"], calls[0]["crate_features"])
                    self.assertEqual(["cloud"], calls[1]["crate_features"])
                    self.assertEqual(
                        {"//provider": "caller_name", "//test-provider": "test_name"},
                        calls[1]["aliases"],
                    )


class BazelTestProfileTests(unittest.TestCase):
    def test_analysis_transitions_use_resolved_build_setting_labels(self):
        setting = "//rust/settings:experimental_per_crate_rustc_flag"
        source = REPOSITORY_ROOT / "bazel/rules/rust_profile_test.bzl"
        for repository in ("rules_rs++rules_rust+rules_rust", "alternate_rules_rust"):
            with self.subTest(repository=repository):
                canonical = "@@" + repository + setting
                transitions = []

                class ResolvedLabel:
                    def __str__(self):
                        return canonical

                def resolve_label(label):
                    self.assertEqual("@rules_rust" + setting, label)
                    return ResolvedLabel()

                def primitive(**kwargs):
                    return None

                namespace = {
                    "Label": resolve_label,
                    "provider": primitive,
                    "aspect": primitive,
                    "rule": primitive,
                    "attr": SimpleNamespace(
                        string=primitive, bool=primitive, label=primitive
                    ),
                    "analysis_test_transition": lambda *, settings: transitions.append(
                        settings
                    ),
                }
                # Execute the real transition declarations; only Bazel primitives
                # are stubbed here; this checks forwarding, not label resolution.
                exec(
                    compile(source.read_text(encoding="utf-8"), str(source), "exec"),
                    namespace,
                )
                self.assertEqual(
                    [
                        {
                            "//command_line_option:compilation_mode": "fastbuild",
                            canonical: [],
                        },
                        {
                            "//command_line_option:compilation_mode": "opt",
                            canonical: [],
                        },
                        {
                            "//command_line_option:compilation_mode": "fastbuild",
                            canonical: ["@-Copt-level=1"],
                        },
                    ],
                    transitions,
                )

    def test_identity_hash_optimization_is_scoped_to_the_ci_test_profile(self):
        option = "--@rules_rust//rust/settings:experimental_per_crate_rustc_flag="
        settings = []
        for line in (
            (REPOSITORY_ROOT / ".bazelrc").read_text(encoding="utf-8").splitlines()
        ):
            if option in line and not line.lstrip().startswith("#"):
                scope, value = line.split()
                settings.append((scope, value.removeprefix(option)))
        self.assertEqual(
            [("test:ci", "external/rules_rs++crate+crates__sha2-0.10.@-Copt-level=1")],
            settings,
        )
        prefix, flag = settings[0][1].split("@")
        workspace, _ = workspace_manifests(REPOSITORY_ROOT)
        self.assertEqual(
            "0.10",
            workspace["dependencies"]["sha2"],
            "Update the test-profile crate filter when the workspace sha2 requirement changes",
        )
        module = ast.parse(
            (REPOSITORY_ROOT / "MODULE.bazel").read_text(encoding="utf-8")
        )
        crate_extension = next(
            node.value
            for node in module.body
            if isinstance(node, ast.Assign)
            and any(
                isinstance(target, ast.Name) and target.id == "crate"
                for target in node.targets
            )
        )
        self.assertEqual("use_extension", crate_extension.func.id)
        self.assertEqual(
            ["@rules_rs//rs:extensions.bzl", "crate"],
            [ast.literal_eval(argument) for argument in crate_extension.args],
        )
        self.assertTrue(
            any(
                isinstance(node, ast.Expr)
                and isinstance(node.value, ast.Call)
                and isinstance(node.value.func, ast.Name)
                and node.value.func.id == "use_repo"
                and isinstance(node.value.args[0], ast.Name)
                and node.value.args[0].id == "crate"
                and ast.literal_eval(node.value.args[1]) == "crates"
                for node in module.body
            )
        )
        lock = tomllib.loads(
            (REPOSITORY_ROOT / "Cargo.lock").read_text(encoding="utf-8")
        )
        versions = [
            package["version"]
            for package in lock["package"]
            if package["name"] == "sha2" and package["version"].startswith("0.10.")
        ]
        self.assertTrue(versions)
        flag_annotations = []
        for node in module.body:
            if (
                isinstance(node, ast.Expr)
                and isinstance(node.value, ast.Call)
                and isinstance(node.value.func, ast.Attribute)
                and node.value.func.attr == "annotation"
            ):
                arguments = {key.arg: key.value for key in node.value.keywords}
                if "skip_per_crate_rustc_flags" in arguments:
                    flag_annotations.append(
                        {
                            key: ast.literal_eval(value)
                            for key, value in arguments.items()
                        }
                    )
        self.assertEqual(
            [
                {
                    "crate": "sha2",
                    "version": version,
                    "skip_per_crate_rustc_flags": False,
                    "repositories": ["crates"],
                }
                for version in versions
            ],
            flag_annotations,
            "The generated sha2 target must opt into per-crate flags; a matching prefix alone is insufficient",
        )
        # The pinned rules_rust setting matches an execution-path prefix, not a crate name.
        for version in versions:
            self.assertTrue(
                f"external/rules_rs++crate+crates__sha2-{version}/src/lib.rs".startswith(
                    prefix
                )
            )
        for other in ("sha2-asm-0.6.4", "sha256-1.0.0", "sha2-0.11.0"):
            self.assertFalse(
                f"external/rules_rs++crate+crates__{other}/src/lib.rs".startswith(
                    prefix
                )
            )
        self.assertEqual("-Copt-level=1", flag)

    def test_ci_workflow_and_local_instructions_use_the_same_bazel_test_profile(self):
        workflow = (REPOSITORY_ROOT / ".github/workflows/bazel-boundary.yml").read_text(
            encoding="utf-8"
        )
        commands = [
            line.strip() for line in workflow.splitlines() if "bazel test " in line
        ]
        self.assertEqual(2, len(commands))
        for command in commands:
            self.assertIn("bazel test --config=ci ", command)
        self.assertIn("//bazel:rust-test-profile-contract", workflow)
        documentation = (REPOSITORY_ROOT / "docs/build.md").read_text(encoding="utf-8")
        self.assertIn("bazelisk test --config=ci //app-rs:app_ci", documentation)

    def test_failure_artifacts_use_the_configured_bazel_testlogs_directory(self):
        bazelrc = (REPOSITORY_ROOT / ".bazelrc").read_text(encoding="utf-8")
        prefixes = [
            line.removeprefix("common --symlink_prefix=")
            for line in bazelrc.splitlines()
            if line.startswith("common --symlink_prefix=")
        ]
        self.assertEqual(1, len(prefixes))
        workflow = (REPOSITORY_ROOT / ".github/workflows/bazel-boundary.yml").read_text(
            encoding="utf-8"
        )
        for filename in ("test.log", "test.xml"):
            self.assertIn(
                f"{prefixes[0]}testlogs/ash-cli/tui-real-scenarios/{filename}",
                workflow,
            )
        self.assertIn("include-hidden-files: true", workflow)


class BazelMacroSignatureFixtureTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        (self.root / "consumer").mkdir()
        self.build = self.root / "consumer/BUILD.bazel"
        # A later required parameter must be discovered from the owning macro.
        (self.root / "defs.bzl").write_text(
            "def owned_binary(name, crate_root, deps, data = [], *, feature_mode):\n    pass\n",
            encoding="utf-8",
        )

    def check_call(self, arguments):
        self.build.write_text(
            f'load("//:defs.bzl", binary = "owned_binary")\nbinary({arguments})\n',
            encoding="utf-8",
        )
        return macro_required_argument_errors(self.root, self.build)

    def test_positional_required_and_optional_defaults_pass(self):
        self.assertEqual(
            [], self.check_call('"fixture", "src/main.rs", [], feature_mode="test"')
        )

    def test_each_missing_required_argument_reports_build_and_owner(self):
        arguments = {
            "name": "fixture",
            "crate_root": "src/main.rs",
            "deps": [],
            "feature_mode": "test",
        }
        for missing in arguments:
            with self.subTest(missing=missing):
                call = ", ".join(
                    f"{name}={value!r}"
                    for name, value in arguments.items()
                    if name != missing
                )
                self.assertEqual(
                    [
                        f"consumer/BUILD.bazel:2: binary: missing required arguments ['{missing}'] from defs.bzl"
                    ],
                    self.check_call(call),
                )

    def test_dynamic_arguments_are_explicitly_unsupported(self):
        for arguments in ("*inputs", "**inputs"):
            with self.subTest(arguments=arguments):
                self.assertEqual(
                    [
                        "consumer/BUILD.bazel:2: binary: dynamic arguments cannot be checked against defs.bzl"
                    ],
                    self.check_call(arguments),
                )


class BazelDependencyContractFixtureTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.write(
            "Cargo.toml",
            """
            [workspace]
            members = ["consumer", "provider"]
            [workspace.dependencies]
            provider-package = { path = "provider", features = ["cloud"] }
            """,
        )
        self.write(
            "consumer/Cargo.toml",
            """
            [package]
            name = "consumer"
            [dependencies]
            provider-package = { workspace = true, features = ["stream"] }
            """,
        )
        self.write(
            "provider/Cargo.toml",
            """
            [package]
            name = "provider-package"
            [lib]
            name = "provider_api"
            [features]
            cloud = []
            stream = []
            """,
        )
        self.write(
            "consumer/BUILD.bazel",
            """
            ash_rust_crate(
                name = "consumer",
                crate_name = "consumer",
                extra_aliases = {"//provider": "provider_api"},
            )
            """,
        )
        self.write_provider_build(["cloud", "stream"])

    def write(self, path, contents):
        destination = self.root / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(textwrap.dedent(contents), encoding="utf-8")

    def write_provider_build(self, features):
        self.write(
            "provider/BUILD.bazel",
            f"ash_rust_crate(name='provider', crate_name='provider_api', "
            f"crate_features={features!r})",
        )

    def test_workspace_and_consumer_features_with_library_alias_pass(self):
        self.assertEqual([], dependency_contract_errors(self.root))

    def test_each_missing_inherited_or_consumer_feature_reports_both_paths(self):
        for feature in ("cloud", "stream"):
            with self.subTest(feature=feature):
                self.write_provider_build([feature])
                missing = "stream" if feature == "cloud" else "cloud"
                self.assertEqual(
                    [
                        f"consumer/Cargo.toml: dependency 'provider-package' requests "
                        f"features ['{missing}'] missing from provider/BUILD.bazel "
                        "target 'provider' crate_features"
                    ],
                    dependency_contract_errors(self.root),
                )

    def test_missing_or_wrong_alias_reports_consumer_and_library(self):
        for aliases, actual in (
            ({}, "provider_package"),
            ({"//provider": "stale"}, "stale"),
        ):
            with self.subTest(aliases=aliases):
                self.write(
                    "consumer/BUILD.bazel",
                    f"ash_rust_crate(name='consumer', crate_name='consumer', "
                    f"extra_aliases={aliases!r})",
                )
                self.assertEqual(
                    [
                        "consumer/Cargo.toml: dependency 'provider-package' imports "
                        "'provider_api', but consumer/BUILD.bazel target 'consumer' "
                        f"aliases //provider as '{actual}'; dependency library is "
                        "provider/Cargo.toml"
                    ],
                    dependency_contract_errors(self.root),
                )

    def test_explicit_dependency_rename_takes_precedence_over_library_name(self):
        self.write(
            "consumer/Cargo.toml",
            """
            [package]
            name = "consumer"
            [dependencies]
            client-api = { package = "provider-package", path = "../provider", features = ["cloud"] }
            """,
        )
        self.write(
            "consumer/BUILD.bazel",
            "ash_rust_crate(name='consumer', crate_name='consumer')",
        )
        self.assertEqual([], dependency_contract_errors(self.root))

    def test_explicit_same_package_name_still_overrides_library_name(self):
        self.write(
            "Cargo.toml",
            """
            [workspace]
            members = ["consumer", "provider"]
            [workspace.dependencies]
            provider-package = { package = "provider-package", path = "provider" }
            """,
        )
        self.write(
            "consumer/BUILD.bazel",
            "ash_rust_crate(name='consumer', crate_name='consumer')",
        )
        self.assertEqual([], dependency_contract_errors(self.root))

    def test_binary_alias_override_is_checked_and_shared_constants_are_read(self):
        self.write(
            "consumer/BUILD.bazel",
            """
            _ALIASES = {"//provider": "provider_api"}
            ash_rust_binary(name="consumer", crate_name="consumer", crate_root="src/main.rs",
                            deps=[], extra_aliases=_ALIASES)
            """,
        )
        self.assertEqual([], dependency_contract_errors(self.root))
        self.write(
            "consumer/BUILD.bazel",
            """
            ash_rust_binary(name="consumer", crate_name="consumer", crate_root="src/main.rs", deps=[])
            """,
        )
        errors = dependency_contract_errors(self.root)
        self.assertEqual(1, len(errors))
        self.assertIn(
            "consumer/BUILD.bazel target 'consumer' aliases //provider as 'provider_package'",
            errors[0],
        )

    def test_app_metadata_key_must_be_the_cargo_member_path(self):
        self.write(
            "consumer/Cargo.toml",
            """
            [package]
            name = "consumer-package"
            [dependencies]
            provider-package = { package = "provider-package", path = "../provider" }
            """,
        )
        for package, expected in (
            ("consumer", []),
            (
                "consumer-package",
                [
                    "consumer/BUILD.bazel: package_name 'consumer-package' does not identify "
                    "Cargo metadata path 'consumer' for consumer/Cargo.toml"
                ],
            ),
        ):
            with self.subTest(package=package):
                self.write(
                    "consumer/BUILD.bazel",
                    f'app_rust_binary(name="consumer", crate_name="consumer", '
                    f'package_name={package!r}, crate_root="src/main.rs")',
                )
                self.assertEqual(expected, dependency_contract_errors(self.root))

    def test_dynamic_required_attributes_are_reported_instead_of_skipped(self):
        self.write(
            "provider/BUILD.bazel",
            """
            ash_rust_crate(name="provider", crate_name="provider_api",
                           crate_features=select({"//conditions:default": ["cloud", "stream"]}))
            """,
        )
        with self.assertRaisesRegex(
            AssertionError, "crate_features must be statically readable"
        ) as error:
            dependency_contract_errors(self.root)
        self.assertIn(str(self.root / "provider/BUILD.bazel"), str(error.exception))

    def test_duplicate_attributes_from_a_clean_merge_are_rejected(self):
        self.write(
            "provider/BUILD.bazel",
            'ash_rust_crate(name="provider", crate_features=["cloud"], crate_features=["cloud"])',
        )
        with self.assertRaisesRegex(SyntaxError, "keyword argument repeated") as error:
            dependency_contract_errors(self.root)
        self.assertEqual(
            str(self.root / "provider/BUILD.bazel"), error.exception.filename
        )

    def test_unknown_consumer_macro_is_reported_instead_of_skipped(self):
        self.write("consumer/BUILD.bazel", 'custom_rust_binary(name="consumer")')
        with self.assertRaisesRegex(
            AssertionError, "no statically readable Rust consumer target"
        ) as error:
            dependency_contract_errors(self.root)
        self.assertIn(str(self.root / "consumer/BUILD.bazel"), str(error.exception))

    def test_raw_library_default_crate_name_matches_cargo(self):
        self.write("consumer/BUILD.bazel", 'rust_library(name="consumer")')
        self.write(
            "provider/BUILD.bazel",
            'rust_library(name="provider", crate_features=["cloud", "stream"])',
        )
        self.write(
            "provider/Cargo.toml",
            '[package]\nname="provider-package"\n[lib]\nname="provider"\n',
        )
        self.assertEqual([], dependency_contract_errors(self.root))

    def test_features_on_another_variant_do_not_satisfy_default_target(self):
        self.write(
            "provider/BUILD.bazel",
            """
            ash_rust_crate(name="provider", crate_name="provider_api")
            ash_rust_crate(name="enabled", crate_name="provider_api", crate_features=["cloud", "stream"])
            """,
        )
        errors = dependency_contract_errors(self.root)
        self.assertEqual(1, len(errors))
        self.assertIn("features ['cloud', 'stream']", errors[0])
        self.assertIn("target 'provider' crate_features", errors[0])

    def test_bazel_alias_resolves_the_selected_library_variant(self):
        self.write(
            "provider/BUILD.bazel",
            """
            alias(name="provider", actual=":enabled")
            ash_rust_crate(name="enabled", crate_name="provider_api", crate_features=["cloud", "stream"])
            """,
        )
        self.assertEqual([], dependency_contract_errors(self.root))
        self.write("provider/BUILD.bazel", 'alias(name="provider", actual=":missing")')
        with self.assertRaises(AssertionError) as error:
            dependency_contract_errors(self.root)
        self.assertEqual(
            f"{self.root / 'provider/BUILD.bazel'}: missing library target 'missing'",
            str(error.exception),
        )

    def test_conditional_and_test_features_are_not_assumed_always_enabled(self):
        self.write_provider_build([])
        for section, spec in (
            ("dependencies", 'path="../provider", optional=true'),
            ("dev-dependencies", 'path="../provider"'),
            ("build-dependencies", 'path="../provider"'),
            ("target.'cfg(windows)'.dependencies", 'path="../provider"'),
        ):
            with self.subTest(section=section):
                self.write(
                    "consumer/Cargo.toml",
                    f'[package]\nname="consumer"\n[{section}]\n'
                    f'provider-package = {{ {spec}, features=["cloud"] }}\n',
                )
                self.assertEqual([], dependency_contract_errors(self.root))


if __name__ == "__main__":
    unittest.main()
