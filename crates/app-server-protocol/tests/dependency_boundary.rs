use std::process::Command;

fn dependency_tree(selection: &[&str]) -> String {
    // Inspect selected normal dependencies: workspace metadata also contains the
    // optional execution graph and cannot establish the client's build boundary.
    let output = Command::new(env!("CARGO"))
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .args([
            "tree",
            "--locked",
            "--offline",
            "--edges",
            "normal",
            "--prefix",
            "none",
            "--format",
            "{p}",
        ])
        .args(selection)
        .output()
        .expect("inspect the protocol's selected Cargo dependencies");
    assert!(
        output.status.success(),
        "cargo tree failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("Cargo package names are UTF-8")
}

#[test]
fn default_protocol_build_does_not_compile_service_implementations() {
    let tree = dependency_tree(&["-p", "ash-app-server-protocol"]);
    for forbidden in [
        "ash-queue",
        "ash-call",
        "ash-collaboration",
        "ash-task-delivery",
        "ash-core",
        "ash-extension-api",
        "ash-tools",
        "ash-file-system",
        "arboard",
        "image",
        "rusqlite",
        "libsqlite3-sys",
    ] {
        assert!(
            !tree
                .lines()
                .any(|line| line.split_whitespace().next() == Some(forbidden)),
            "protocol compilation includes service dependency {forbidden}:\n{tree}"
        );
    }
}

#[test]
fn service_features_do_not_make_protocol_depend_on_queue_execution() {
    // The App Server enables task delivery's runtime feature. Cargo unifies
    // features, so a default-only tree would miss this execution dependency.
    let tree = dependency_tree(&["-p", "ash-app-server", "--invert", "ash-queue"]);
    assert!(
        tree.lines()
            .any(|line| line.split_whitespace().next() == Some("ash-app-server")),
        "expected the real server's queue execution graph: {tree}"
    );
    assert!(
        !tree
            .lines()
            .any(|line| line.split_whitespace().next() == Some("ash-app-server-protocol")),
        "service features pull queue execution into protocol compilation: {tree}"
    );
}
