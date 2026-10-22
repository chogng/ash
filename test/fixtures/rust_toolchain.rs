use std::path::Path;

/// Isolated Cargo projects do not inherit Ash's .cargo/config.toml. Use the same
/// bundled Windows x64 linker and explicitly discovered SDK libraries.
pub fn configure(root: &Path, linker: cc::Tool) {
    std::fs::write(
        root.join("rust-toolchain.toml"),
        include_str!("../../rust-toolchain.toml"),
    )
    .unwrap();
    let libraries = linker.env().iter().find(|(name, _)| name == "LIB")
        .expect("MSVC toolchain supplies SDK and runtime libraries");
    std::fs::create_dir_all(root.join(".cargo")).unwrap();
    std::fs::write(
        root.join(".cargo/config.toml"),
        format!(
            "[target.x86_64-pc-windows-msvc]\nlinker = \"rust-lld\"\n[env]\nLIB = {}\n",
            serde_json::to_string(&libraries.1.to_string_lossy()).unwrap(),
        ),
    )
    .unwrap();
}
