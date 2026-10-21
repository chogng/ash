"""Import the Linux host's Wayland interface without its libc search directory."""

def _system_wayland_impl(ctx):
    if ctx.os.name != "linux":
        fail("The system Wayland interface requires a Linux build host.")
    pkg_config = ctx.which("pkg-config")
    if not pkg_config:
        fail("Install pkg-config and libwayland-dev for Linux Bazel builds.")
    result = ctx.execute([pkg_config, "--variable=libdir", "wayland-client"])
    if result.return_code:
        fail("Cannot locate the system Wayland client: " + result.stderr)
    library = ctx.path(result.stdout.strip()).get_child("libwayland-client.so")
    if not library.exists:
        fail("Install libwayland-dev; missing " + str(library))
    ctx.symlink(library, "lib/libwayland-client.so")
    ctx.file("BUILD.bazel", """load("@rules_cc//cc:defs.bzl", "cc_import")

cc_import(
    name = "client",
    interface_library = "lib/libwayland-client.so",
    system_provided = True,
    visibility = ["//visibility:public"],
)
""")

system_wayland = repository_rule(
    implementation = _system_wayland_impl,
    configure = True,
    local = True,
)
