use super::*;
use crate::reload::ImageKind;
use crate::reload::Manifest;
use crate::reload::digest;
use crate::reload::image_path;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use std::time::Instant;

unsafe extern "C" fn collect(context: *mut c_void, bytes: *const u8, length: usize) {
    // SAFETY: tests supply their Vec and respond supplies a live output buffer.
    unsafe { &mut *context.cast::<Vec<u8>>() }
        .extend_from_slice(unsafe { std::slice::from_raw_parts(bytes, length) });
}

#[test]
fn response_copies_bytes_and_contains_panics_and_invalid_input() {
    let mut output = Vec::<u8>::new();
    let context = (&raw mut output).cast();
    // SAFETY: valid stack buffers and synchronous collection callback.
    unsafe {
        assert_eq!(
            respond(b"in".as_ptr(), 2, collect, context, |input| [input, b"put"]
                .concat()),
            0
        );
        assert_eq!(output, b"input");
        assert_eq!(
            respond(std::ptr::null(), 1, collect, context, |_| unreachable!()),
            2
        );
        assert_eq!(
            respond(std::ptr::null(), 0, collect, context, |_| panic!(
                "module failed"
            )),
            1
        );
        assert_eq!(
            respond(std::ptr::null(), 0, collect, context, |_| vec![
                0;
                MAX_MESSAGE_BYTES
                    + 1
            ]),
            3
        );
    }
}

fn fixture(directory: &Path, name: &str, version: u32) -> Vec<u8> {
    let source = directory.join(format!("{name}.rs"));
    std::fs::write(&source, format!(r#"
use std::ffi::c_void;
#[unsafe(no_mangle)]
pub extern "C" fn ash_dev_abi_version() -> u32 {{ {version} }}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ash_dev_invoke_v1(
    input: *const u8, length: usize,
    write: unsafe extern "C" fn(*mut c_void, *const u8, usize), context: *mut c_void,
) -> i32 {{
    if length > 0 {{
        let path = std::str::from_utf8(unsafe {{ std::slice::from_raw_parts(input, length) }}).unwrap();
        std::fs::write(path, b"entered").unwrap();
        let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !std::path::Path::new(&format!("{{path}}.release")).exists() {{
            if std::time::Instant::now() > until {{ return 1; }}
            std::thread::sleep(std::time::Duration::from_millis(5));
        }}
    }}
    unsafe {{ write(context, b"{name}".as_ptr(), {length}) }};
    0
}}
"#, length = name.len())).unwrap();
    let output = directory.join(format!("{name}.{}", std::env::consts::DLL_EXTENSION));
    let mut compiler = Command::new("rustc");
    compiler.args(["--edition=2024", "--crate-type=cdylib", "-C", "debuginfo=0"]);
    #[cfg(windows)]
    compiler.args(["-C", "linker=rust-lld", "-C", "target-feature=-crt-static"]);
    let result = compiler
        .arg(source)
        .arg("-o")
        .arg(&output)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    std::fs::read(output).unwrap()
}

fn publish(directory: &Path, bytes: &[u8]) {
    std::fs::create_dir_all(directory.join("objects")).unwrap();
    let sha256 = digest(bytes);
    std::fs::write(image_path(directory, &sha256), bytes).unwrap();
    let manifest = serde_json::to_vec(&Manifest {
        version: ABI_VERSION,
        sha256,
        kind: ImageKind::Json,
    })
    .unwrap();
    let pending = directory.join("pending.json");
    std::fs::write(&pending, manifest).unwrap();
    std::fs::rename(pending, directory.join("current.json")).unwrap();
}

#[test]
fn native_replacement_retains_inflight_calls_and_rejects_invalid_generations() {
    let root = tempfile::tempdir().unwrap();
    let first = fixture(root.path(), "first", ABI_VERSION);
    let second = fixture(root.path(), "second", ABI_VERSION);
    let wrong = fixture(root.path(), "wrong", ABI_VERSION + 1);
    let directory = root.path().join("published");
    let module = Arc::new(ReloadableModule::new(directory.clone()));
    assert!(module.call(b"").is_err());
    publish(&directory, &first);
    assert_eq!(module.call(b"").unwrap(), b"first");
    let entered = root.path().join("entered");
    let input = entered.to_str().unwrap().as_bytes().to_vec();
    let pending = Arc::clone(&module);
    let call = thread::spawn(move || pending.call(&input));
    let until = Instant::now() + Duration::from_secs(5);
    while !entered.exists() {
        assert!(Instant::now() < until, "old module did not enter its call");
        thread::sleep(Duration::from_millis(5));
    }
    publish(&directory, &second);
    assert_eq!(module.call(b"").unwrap(), b"second");
    std::fs::write(entered.with_extension("release"), b"").unwrap();
    assert_eq!(call.join().unwrap().unwrap(), b"first");
    publish(&directory, &wrong);
    assert_eq!(module.call(b"").unwrap(), b"second");
    let hash = digest(&first);
    std::fs::write(image_path(&directory, &hash), b"corrupt").unwrap();
    std::fs::write(
        directory.join("current.json"),
        serde_json::to_vec(&Manifest {
            version: ABI_VERSION,
            sha256: hash,
            kind: ImageKind::Json,
        })
        .unwrap(),
    )
    .unwrap();
    assert_eq!(module.call(b"").unwrap(), b"second");
    std::fs::write(
        directory.join("current.json"),
        br#"{"version":1,"sha256":"../../escape"}"#,
    )
    .unwrap();
    assert_eq!(module.call(b"").unwrap(), b"second");
    std::fs::remove_file(directory.join("current.json")).unwrap();
    assert_eq!(module.call(b"").unwrap(), b"second");
    std::fs::write(directory.join("current.json"), vec![b' '; 2048]).unwrap();
    assert_eq!(module.call(b"").unwrap(), b"second");
}
