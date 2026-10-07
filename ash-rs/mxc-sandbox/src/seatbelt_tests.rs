use super::*;
use crate::MxcSandbox;
use ash_file_access::Dir;
use ash_install_context::InstallContext;
use ash_sandboxing::FileSystemAccess;
use ash_sandboxing::NetworkAccess;
use ash_sandboxing::PatternMatchTiming;
use ash_sandboxing::SandboxBackend;
use ash_sandboxing::SandboxCommand;
use ash_sandboxing::SandboxPathRule;
use ash_sandboxing::SandboxPolicy;
use ash_sandboxing::SandboxProcessExitStatus;
use std::io::Read;

// These are the common path grammar cases exercised by the frontend glob
// tests. Validate the OS policy too, rather than merely comparing regex text.
#[test]
fn configured_glob_cases_match_in_real_seatbelt_children() {
    for (pattern, candidate, denied) in [
        ("**/*.ts", "main.ts", true),
        ("**/*.ts", "src/nested/main.ts", true),
        ("src/**/*.{ts,tsx}", "src/main.tsx", true),
        ("src/**/file[0-9]?.ts", "src/deep/file1a.ts", true),
        ("src/[!a]*.ts", "src/b.ts", true),
        ("src/[!a]*.ts", "src/a.ts", false),
        ("*.ts", "src/main.ts", false),
        ("**/*.{ts,{js,jsx}}", "main.jsx", true),
        ("src\\**\\*.ts", "src/main.ts", true),
        ("**/中文*.txt", "nested/中文文件.txt", true),
        ("**/?.txt", "nested/中.txt", false),
        ("**/???.txt", "nested/中.txt", true),
        (
            "**/{private/nested,other}/secret",
            "private/nested/secret",
            true,
        ),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(candidate);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "canary").unwrap();
        let dir = Dir::open_local(temp.path()).unwrap();
        let scope = SandboxScope::single(dir.clone())
            .with_path_rules(vec![
                SandboxPathRule::pattern(
                    dir,
                    pattern,
                    SandboxPathAccess::Denied,
                    PatternMatchTiming::Continuous,
                )
                .unwrap(),
            ])
            .unwrap();
        let command = SandboxCommand::new(
            "/bin/cat",
            [candidate],
            scope.command_dir().canonical_path(),
        );
        let mut process = MxcSandbox::new(InstallContext::current())
            .prepare_scoped(
                &command,
                SandboxPolicy::new(FileSystemAccess::DirectoryWrite, NetworkAccess::Denied),
                &scope,
            )
            .unwrap()
            .spawn(&[])
            .unwrap();
        let mut stdout = String::new();
        process
            .take_stdout()
            .unwrap()
            .read_to_string(&mut stdout)
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let status = loop {
            if let Some(status) = process.try_wait().unwrap() {
                break status;
            }
            assert!(Instant::now() < deadline, "sandboxed cat did not exit");
            std::thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(
            status != SandboxProcessExitStatus::Code(0),
            denied,
            "{pattern}: {candidate}; {stdout}"
        );
        assert_eq!(stdout.contains("canary"), !denied, "{pattern}: {candidate}");
    }
}

#[test]
fn continuous_denials_reject_existing_hard_link_and_symlink_aliases() {
    for symbolic in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("source"), "canary").unwrap();
        let protected = temp.path().join("secret.txt");
        if symbolic {
            std::os::unix::fs::symlink(temp.path().join("source"), &protected).unwrap();
        } else {
            std::fs::hard_link(temp.path().join("source"), &protected).unwrap();
        }
        let dir = Dir::open_local(temp.path()).unwrap();
        let scope = SandboxScope::single(dir.clone())
            .with_path_rules(vec![
                SandboxPathRule::pattern(
                    dir,
                    "**/secret.*",
                    SandboxPathAccess::Denied,
                    PatternMatchTiming::Continuous,
                )
                .unwrap(),
            ])
            .unwrap();
        let filesystem = scope
            .resolve_filesystem_with_continuous_patterns(FileSystemAccess::DirectoryWrite)
            .unwrap();
        assert!(matches!(
            rules(&scope, &filesystem),
            Err(SandboxError::UnsupportedPolicy(_))
        ));
    }
}

#[test]
fn non_ascii_byte_classes_cannot_silently_change_matching_semantics() {
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let scope = SandboxScope::single(dir.clone())
        .with_path_rules(vec![
            SandboxPathRule::pattern(
                dir,
                "**/[中].txt",
                SandboxPathAccess::Denied,
                PatternMatchTiming::Continuous,
            )
            .unwrap(),
        ])
        .unwrap();
    let filesystem = scope
        .resolve_filesystem_with_continuous_patterns(FileSystemAccess::DirectoryWrite)
        .unwrap();
    assert!(matches!(
        rules(&scope, &filesystem),
        Err(SandboxError::UnsupportedPolicy(_))
    ));
}
