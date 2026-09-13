use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn main() {
    println!("cargo:rerun-if-env-changed=ASH_BUILD_COMMIT");
    println!("cargo:rerun-if-env-changed=ASH_BUILD_ID");
    let commit = std::env::var("ASH_BUILD_COMMIT").ok().or_else(|| {
        for name in ["HEAD", "packed-refs"] {
            if let Some(path) = git(&["rev-parse", "--git-path", name]) {
                println!("cargo:rerun-if-changed={path}");
            }
        }
        if let Some(reference) = git(&["symbolic-ref", "-q", "HEAD"])
            && let Some(path) = git(&["rev-parse", "--git-path", &reference])
        {
            println!("cargo:rerun-if-changed={path}");
        }
        git(&["rev-parse", "HEAD"])
    });
    if let Some(commit) = commit {
        assert!(
            commit.len() == 40 && commit.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "ASH_BUILD_COMMIT must be a full Git commit"
        );
        println!(
            "cargo:rustc-env=ASH_COMPILED_COMMIT={}",
            commit.to_ascii_lowercase()
        );
    }
    println!(
        "cargo:rustc-env=ASH_COMPILED_TARGET={}",
        std::env::var("TARGET").unwrap()
    );
}
