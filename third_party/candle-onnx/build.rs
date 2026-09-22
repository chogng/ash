// Modified by Ash to use a locked protoc from Cargo or the Bazel build tool.

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rerun-if-env-changed=PROTOC");
    let protoc = match std::env::var_os("PROTOC") {
        Some(path) => std::path::PathBuf::from(path),
        None => protoc_bin_vendored::protoc_bin_path()?,
    };
    let mut config = prost_build::Config::new();
    config.protoc_executable(protoc);
    config.compile_protos(&["src/onnx.proto3"], &["src/"])?;
    Ok(())
}
