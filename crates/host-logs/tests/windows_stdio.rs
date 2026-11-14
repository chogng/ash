#![cfg(windows)]

use std::fs;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Write;
use std::process::Command;
use std::process::Stdio;

/// Electron starts the helper with redirected handles, without a console.
/// Keep that launch contract when changing the Windows executable subsystem.
#[test]
fn background_binary_preserves_redirected_log_protocol() {
    let binary = env!("CARGO_BIN_EXE_ash-host-logs");
    let image = fs::read(binary).unwrap();
    let pe = u32::from_le_bytes(image[0x3c..0x40].try_into().unwrap()) as usize;
    let subsystem = pe + 24 + 68;
    assert_eq!(
        u16::from_le_bytes(image[subsystem..subsystem + 2].try_into().unwrap()),
        2,
        "a pipe-only helper must not allocate an implicit Windows console"
    );

    let directory = tempfile::tempdir().unwrap();
    let mut child = Command::new(binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // EOF is sent before awaiting output, so a protocol regression cannot leave
    // the helper waiting for another request while the test waits for exit.
    let mut input = child.stdin.take().unwrap();
    for request in [
        serde_json::json!({
            "op": "initialize", "logsHome": directory.path(),
            "maxFileBytes": 1048576, "retainedSessions": 2,
            "processId": std::process::id()
        }),
        serde_json::json!({
            "op": "append", "source": "main", "entry": {
                "timestampMillis": 1, "level": "information",
                "category": "test", "message": "redirected log record"
            }
        }),
        serde_json::json!({"op": "flush"}),
        serde_json::json!({"op": "close"}),
    ] {
        writeln!(input, "{request}").unwrap();
    }
    drop(input);
    let child_id = child.id();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "{:?}", output.stderr);
    assert!(output.stderr.is_empty());
    let replies: Vec<serde_json::Value> = BufReader::new(output.stdout.as_slice())
        .lines()
        .map(|line| serde_json::from_str(&line.unwrap()).unwrap())
        .collect();
    assert_eq!(replies.len(), 4);
    assert_eq!(replies[0]["kind"], "initialized");
    for reply in &replies[1..] {
        assert_eq!(reply["kind"], "ok");
    }
    let session = std::path::Path::new(replies[0]["sessionPath"].as_str().unwrap());
    let contents = fs::read_to_string(session.join("main.log")).unwrap();
    assert!(contents.contains("redirected log record"));
    assert!(!session.join(format!(".active-{child_id}")).exists());
}
