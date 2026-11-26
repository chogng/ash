use std::collections::BTreeMap;
use std::fmt::Write;
use std::path::PathBuf;

fn main() {
    println!("cargo:rustc-check-cfg=cfg(ash_desktop_native_grammars)");
    println!("cargo:rerun-if-env-changed=ASH_DESKTOP_NATIVE_GRAMMARS");
    if std::env::var("ASH_DESKTOP_NATIVE_GRAMMARS").as_deref() != Ok("1") {
        return;
    }
    assert_eq!(
        std::env::var("TARGET").as_deref(),
        Ok("x86_64-pc-windows-msvc")
    );
    println!("cargo:rustc-cfg=ash_desktop_native_grammars");
    println!("cargo:rerun-if-changed=../../build/desktop/native-grammars.json");
    let grammars: BTreeMap<String, [String; 2]> =
        serde_json::from_str(include_str!("../../build/desktop/native-grammars.json"))
            .expect("Desktop grammar catalog");
    let mut output = String::from("optional_grammars! {\n");
    for (name, [variant, symbol]) in grammars {
        writeln!(
            &mut output,
            "    ({name:?}, {variant}, {symbol:?}, {symbol}),"
        )
        .unwrap();
    }
    output.push_str("}\n");
    let directory = PathBuf::from(std::env::var_os("OUT_DIR").expect("Cargo OUT_DIR"));
    std::fs::write(directory.join("desktop_native_grammars.rs"), output)
        .expect("Write grammar catalog");
}
