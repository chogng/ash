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
    for source in ["bubblewrap.c", "bind-mount.c", "network.c", "utils.c"] {
        let path = source_directory.join(source);
        if !path.is_file() {
            return Err(format!("missing Bubblewrap source: {}", path.display()));
        }
        println!("cargo:rerun-if-changed={}", path.display());
    }

    let output_directory = PathBuf::from(env::var("OUT_DIR").map_err(|error| error.to_string())?);
    let config_header = output_directory.join("config.h");
    std::fs::write(
        &config_header,
        "#pragma once\n#define PACKAGE_STRING \"bubblewrap built for Ash\"\n",
    )
    .map_err(|error| format!("failed to write {}: {error}", config_header.display()))?;

    let libcap = pkg_config::Config::new()
        .cargo_metadata(false)
        .probe("libcap")
        .map_err(|error| format!("libcap is unavailable through pkg-config: {error}"))?;

    let mut build = cc::Build::new();
    build
        .file(source_directory.join("bubblewrap.c"))
        .file(source_directory.join("bind-mount.c"))
        .file(source_directory.join("network.c"))
        .file(source_directory.join("utils.c"))
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
