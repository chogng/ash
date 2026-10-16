"""Give Bazel the same checksum-locked Sherpa static libraries as Cargo."""

_LIBRARIES = [
    "sherpa-onnx-c-api",
    "sherpa-onnx-core",
    "kaldi-decoder-core",
    "sherpa-onnx-kaldifst-core",
    "sherpa-onnx-fstfar",
    "sherpa-onnx-fst",
    "kaldi-native-fbank-core",
    "kissfft-float",
    "piper_phonemize",
    "espeak-ng",
    "ucd",
    "onnxruntime",
    "ssentencepiece_core",
]

def _bundle_impl(ctx):
    ctx.download_and_extract(
        url = ctx.attr.url,
        sha256 = ctx.attr.sha256,
        stripPrefix = ctx.attr.prefix,
    )
    lines = ["load(\"@rules_cc//cc:defs.bzl\", \"cc_import\", \"cc_library\")"]
    for name in _LIBRARIES:
        filename = name + ".lib" if "windows" in ctx.attr.target else "lib" + name + ".a"
        if not ctx.path("lib/" + filename).exists:
            fail("Missing Sherpa static library: " + filename)
        lines.append("cc_import(name = %r, static_library = %r)" % (name, "lib/" + filename))
    linkopts = []
    if ctx.attr.target.endswith("linux-gnu"):
        linkopts = ["-lstdc++", "-lm", "-lpthread", "-ldl"]
    elif ctx.attr.target.endswith("apple-darwin"):
        linkopts = ["-lc++", "-framework", "Foundation"]
    lines.append("cc_library(name = \"library\", deps = %r, linkopts = %r, visibility = [\"//visibility:public\"])" % ([":" + name for name in _LIBRARIES], linkopts))
    ctx.file("BUILD.bazel", "\n".join(lines) + "\n")
    return ctx.repo_metadata(reproducible = True)

_bundle = repository_rule(
    implementation = _bundle_impl,
    attrs = {
        "url": attr.string(mandatory = True),
        "sha256": attr.string(mandatory = True),
        "prefix": attr.string(mandatory = True),
        "target": attr.string(mandatory = True),
    },
)

def _sherpa_impl(ctx):
    lock = json.decode(ctx.read(Label("//third_party/sherpa-onnx:runtime-lock.json")))
    for target, artifact in lock["artifacts"].items():
        _bundle(
            name = "ash_sherpa_" + target.replace("-", "_"),
            url = "%s/releases/download/%s/%s" % (lock["distribution"]["repository"], lock["distribution"]["release"], artifact["name"]),
            sha256 = artifact["sha256"],
            prefix = artifact["name"].removesuffix(".tar.bz2"),
            target = target,
        )
    return ctx.extension_metadata(reproducible = True)

sherpa = module_extension(implementation = _sherpa_impl)
