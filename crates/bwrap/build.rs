use std::env;
use std::path::Path;
use std::path::PathBuf;

fn main() {
    println!("cargo:rustc-check-cfg=cfg(bwrap_available)");
    println!("cargo:rerun-if-env-changed=PKG_CONFIG_ALLOW_CROSS");
    println!("cargo:rerun-if-env-changed=PKG_CONFIG_PATH");
    println!("cargo:rerun-if-env-changed=PKG_CONFIG_SYSROOT_DIR");

    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("linux") {
        return;
    }
    let manifest_directory = PathBuf::from(
        env::var("CARGO_MANIFEST_DIR").expect("Cargo must provide CARGO_MANIFEST_DIR"),
    );
    let source_directory = manifest_directory.join("../vendor/bubblewrap");
    if let Err(error) = build_bubblewrap(&source_directory) {
        panic!("failed to compile Bubblewrap for the Linux package: {error}");
    }
}

fn build_bubblewrap(source_directory: &Path) -> Result<(), String> {
    if !source_directory.is_dir() {
        return Err(format!(
            "vendored Bubblewrap source is not a directory: {}",
            source_directory.display()
        ));
    }
    let sources = [
        "bubblewrap.c",
        "bind-mount.c",
        "network.c",
        "utils.c",
        "chroot_realpath.c",
        "safe_openat.c",
    ];
    for source in sources {
        let path = source_directory.join(source);
        if !path.is_file() {
            return Err(format!("missing Bubblewrap source: {}", path.display()));
        }
        println!("cargo:rerun-if-changed={}", path.display());
    }

    // Cargo otherwise misses headers and version changes outside this crate.
    for name in ["bind-mount.h", "network.h", "utils.h", "ash-source.json"] {
        println!(
            "cargo:rerun-if-changed={}",
            source_directory.join(name).display()
        );
    }
    let metadata_path = source_directory.join("ash-source.json");
    let metadata: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&metadata_path).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    let version = metadata["version"]
        .as_str()
        .filter(|version| {
            !version.is_empty()
                && version
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || byte == b'.')
        })
        .ok_or("invalid vendored Bubblewrap version")?;

    let output_directory = PathBuf::from(env::var("OUT_DIR").map_err(|error| error.to_string())?);
    let config_header = output_directory.join("config.h");
    std::fs::write(
        &config_header,
        format!("#pragma once\n#define PACKAGE_STRING \"bubblewrap {version}\"\n"),
    )
    .map_err(|error| format!("failed to write {}: {error}", config_header.display()))?;

    let libcap = pkg_config::Config::new()
        .cargo_metadata(false)
        .probe("libcap")
        .map_err(|error| format!("libcap is unavailable through pkg-config: {error}"))?;

    let mut build = cc::Build::new();
    for source in sources {
        build.file(source_directory.join(source));
    }
    build
        .include(&output_directory)
        .include(source_directory)
        .define("_GNU_SOURCE", None)
        .define("main", Some("bwrap_main"));
    for include_path in libcap.include_paths {
        build.flag(format!("-idirafter{}", include_path.display()));
    }
    build.compile("ash_bundled_bwrap");
    for link_path in libcap.link_paths {
        println!("cargo:rustc-link-search=native={}", link_path.display());
    }
    for library in libcap.libs {
        println!("cargo:rustc-link-lib={library}");
    }
    println!("cargo:rustc-cfg=bwrap_available");
    Ok(())
}
