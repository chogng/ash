use std::path::Path;
use std::sync::OnceLock;

pub fn executable() -> &'static str {
    static EXECUTABLE: OnceLock<String> = OnceLock::new();
    EXECUTABLE.get_or_init(|| {
        let directory = Path::new(env!("CARGO_BIN_EXE_ash")).parent().unwrap();
        let path = directory.join(if cfg!(windows) { "ash-remote-server.exe" } else { "ash-remote-server" });
        assert!(path.is_file(), "build the Remote runtime before this test: python3 -B scripts/cargo.py build -p ash-remote-server --bin ash-remote-server");
        path.into_os_string().into_string().unwrap()
    })
}
