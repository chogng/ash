use std::path::Path;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=src/bounded_allocator.cc");
    // Cargo owns source selection. Resolve headers from its locked graph so this shim and
    // the linked engine cannot silently use different V8 allocator interfaces.
    let metadata = Command::new(std::env::var_os("CARGO").expect("Cargo executable"))
        .args(["metadata", "--locked", "--offline", "--format-version=1"])
        .output()
        .expect("resolve locked V8 headers");
    assert!(
        metadata.status.success(),
        "{}",
        String::from_utf8_lossy(&metadata.stderr)
    );
    let metadata: serde_json::Value =
        serde_json::from_slice(&metadata.stdout).expect("Cargo metadata");
    let packages = metadata["packages"].as_array().expect("Cargo packages");
    let v8 = packages
        .iter()
        .find(|package| package["name"] == "v8")
        .expect("V8 dependency");
    let manifest = Path::new(v8["manifest_path"].as_str().expect("V8 manifest"));
    let include = manifest.parent().expect("V8 source").join("v8/include");
    let mut compiler = cc::Build::new();
    compiler.cpp(true).std("c++20");
    // V8's public headers contain intentionally unused virtual parameters. Mark the
    // dependency as a system include; warnings in our shim remain enabled.
    if compiler.get_compiler().is_like_msvc() {
        compiler.flag(format!("/external:I{}", include.display()));
    } else {
        compiler
            .flag("-isystem")
            .flag(include.to_str().expect("V8 include path"));
    }
    compiler
        .define("V8_COMPRESS_POINTERS", None)
        .define("V8_COMPRESS_POINTERS_IN_SHARED_CAGE", None)
        .define("V8_ENABLE_SANDBOX", None)
        .file("src/bounded_allocator.cc")
        .compile("ash_bounded_array_buffer_allocator");
}
