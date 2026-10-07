fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!(
        "cargo:rustc-env=ASH_COMPILED_TARGET={}",
        std::env::var("TARGET").unwrap()
    );
}
