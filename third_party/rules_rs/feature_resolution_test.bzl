load("@bazel_skylib//lib:unittest.bzl", "asserts", "unittest")
load("@rules_rs//rs/private:cargo_workspace_graph.bzl", "cargo_toml_dependencies")
load("@rules_rs//rs/private:resolver.bzl", "resolve")

def _ignore_progress(_message):
    pass

def _features(index, enabled, possible, deps = []):
    return struct(
        package_index = index,
        features_enabled = enabled,
        possible_features = possible,
        possible_deps = deps,
        deps = {triple: set() for triple in enabled},
        build_deps = {triple: set() for triple in enabled},
        aliases = {},
    )

def _nested_platform_features_impl(ctx):
    env = unittest.begin(ctx)
    runtime = _features(0, {"linux": set(), "macos": set()}, {
        "broadcast": ["event"],
        "lock": ["event"],
        "event": [],
        "runtime": [],
    })
    bus = _features(1, {"linux": set(["default-rt"]), "macos": set()}, {
        "default-rt": ["comms", "runtime/runtime"],
        "comms": ["dep:runtime", "runtime/broadcast", "runtime/lock"],
    }, [{
        "name": "runtime",
        "optional": True,
        "bazel_target": "runtime",
        "target": set(["linux", "macos"]),
        "feature_resolutions": runtime,
    }])
    packages = [
        {"name": "runtime", "version": "1", "feature_resolutions": runtime},
        {"name": "bus", "version": "1", "feature_resolutions": bus},
    ]
    resolve(struct(report_progress = _ignore_progress), packages, {}, {}, False)
    asserts.equals(env, ["broadcast", "event", "lock", "runtime"], sorted(runtime.features_enabled["linux"]))
    asserts.equals(env, [], sorted(runtime.features_enabled["macos"]))
    asserts.equals(env, ["runtime"], sorted(bus.deps["linux"]))
    asserts.equals(env, [], sorted(bus.deps["macos"]))
    return unittest.end(env)

nested_platform_features_test = unittest.make(_nested_platform_features_impl)

def _target_build_dependencies_impl(ctx):
    env = unittest.begin(ctx)
    target = "cfg(windows)"
    dependencies = cargo_toml_dependencies({
        "package": {"name": "fixture"},
        "dependencies": {"runtime": "1"},
        "target": {target: {
            "dependencies": {"platform-runtime": "1"},
            "build-dependencies": {
                "cc": "1",
                "windows": {"workspace": True, "features": ["Win32_Security"]},
            },
        }},
    }, {"workspace": {"dependencies": {
        "windows": {"version": "0.62", "features": ["Win32_Foundation"]},
    }}})
    build = {dep["name"]: dep for dep in dependencies if dep.get("kind") == "build"}
    asserts.equals(env, ["cc", "windows"], sorted(build.keys()))
    asserts.equals(env, target, build["cc"]["target"])
    asserts.equals(env, target, build["windows"]["target"])
    asserts.equals(env, "0.62", build["windows"]["req"])
    asserts.equals(env, ["Win32_Foundation", "Win32_Security"], build["windows"]["features"])
    runtime = {dep["name"]: dep for dep in dependencies if dep.get("kind") != "build"}
    asserts.equals(env, ["platform-runtime", "runtime"], sorted(runtime.keys()))
    asserts.equals(env, None, runtime["runtime"].get("target"))
    asserts.equals(env, target, runtime["platform-runtime"]["target"])
    return unittest.end(env)

target_build_dependencies_test = unittest.make(_target_build_dependencies_impl)
