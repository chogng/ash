#![cfg(target_os = "linux")]

use std::process::Command;

#[test]
fn bundled_version_matches_package_metadata() {
    let metadata: serde_json::Value =
        serde_json::from_str(include_str!("../../vendor/bubblewrap/ash-source.json")).unwrap();
    // MXC probes this output before allowing the bundled helper to start a sandbox.
    let output = Command::new(env!("CARGO_BIN_EXE_bwrap"))
        .arg("--version")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        format!("bubblewrap {}\n", metadata["version"].as_str().unwrap())
    );
}
