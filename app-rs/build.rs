fn main() {
    println!("cargo:rerun-if-changed=../resources/win32/ash.ico");
    let target =
        std::env::var("CARGO_CFG_TARGET_OS").expect("Cargo sets the target operating system");
    if target != "windows" {
        return;
    }

    winresource::WindowsResource::new()
        .set_icon("../resources/win32/ash.ico")
        .set("FileDescription", "Ash")
        .set("ProductName", "Ash")
        .compile()
        .expect("Windows application icon must be embedded in app.exe");
}
