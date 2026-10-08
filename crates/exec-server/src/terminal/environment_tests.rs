use super::*;

#[cfg(any(unix, windows))]
#[test]
fn process_environment_ignores_non_unicode_without_losing_safe_values() {
    const CHILD: &str = "ASH_TERMINAL_ENVIRONMENT_TEST_CHILD";
    if std::env::var_os(CHILD).is_none() {
        // Exercise the real process environment without mutating the parallel test runner.
        let current = std::thread::current();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", current.name().unwrap(), "--nocapture"])
            .env(CHILD, "1")
            .env(non_unicode(), "unrepresentable-name")
            .env("IGNORED_NON_UNICODE", non_unicode())
            .env("LC_INVALID", non_unicode())
            .env("LANG", "中文🧊.UTF-8")
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        assert!(
            String::from_utf8(output.stdout)
                .unwrap()
                .contains("1 passed")
        );
        return;
    }
    let environment = safe_process_environment();
    assert_eq!(environment["LANG"], "中文🧊.UTF-8");
    assert!(!environment.contains_key("LC_INVALID"));
    assert!(!environment.contains_key("IGNORED_NON_UNICODE"));
    assert!(!environment.contains_key(CHILD));
    assert_eq!(environment["TERM_PROGRAM"], "ash");
    let profiles = crate::terminal::profiles::TerminalProfileCatalog::discover();
    assert_eq!(profiles.environment()["LANG"], "中文🧊.UTF-8");
}

#[cfg(unix)]
fn non_unicode() -> OsString {
    use std::os::unix::ffi::OsStringExt;
    OsString::from_vec(vec![b'x', 255])
}

#[cfg(windows)]
fn non_unicode() -> OsString {
    use std::os::windows::ffi::OsStringExt;
    OsString::from_wide(&[0xd800])
}

#[test]
fn environment_keeps_safe_values_and_excludes_secrets() {
    let environment = TerminalEnvironment::from_variables([
        ("HOME".into(), "/home/ash".into()),
        ("LANG".into(), "en_US.UTF-8".into()),
        ("LC_ALL".into(), "C.UTF-8".into()),
        ("PATH".into(), "/usr/bin".into()),
        ("OPENAI_API_KEY".into(), "secret".into()),
        ("AWS_SECRET_ACCESS_KEY".into(), "secret".into()),
    ]);

    assert_eq!(
        environment.variables().get("HOME").map(String::as_str),
        Some("/home/ash")
    );
    assert_eq!(
        environment.variables().get("LC_ALL").map(String::as_str),
        Some("C.UTF-8")
    );
    assert!(!environment.variables().contains_key("OPENAI_API_KEY"));
    assert!(
        !environment
            .variables()
            .contains_key("AWS_SECRET_ACCESS_KEY")
    );
}

#[test]
fn environment_owns_terminal_identity_values() {
    let environment = TerminalEnvironment::from_variables([
        ("TERM".into(), "host-term".into()),
        ("COLORTERM".into(), "host-color".into()),
        ("TERM_PROGRAM".into(), "host-program".into()),
    ]);

    assert_eq!(environment.variables()["TERM"], "xterm-256color");
    assert_eq!(environment.variables()["COLORTERM"], "truecolor");
    assert_eq!(environment.variables()["TERM_PROGRAM"], "ash");
}

#[test]
fn environment_rejects_invalid_names_and_values() {
    let environment = TerminalEnvironment::from_variables([
        ("BAD=NAME".into(), "value".into()),
        ("HOME".into(), "bad\0value".into()),
        ("\0PATH".into(), "/bin".into()),
    ]);

    assert!(!environment.variables().contains_key("BAD=NAME"));
    assert!(!environment.variables().contains_key("HOME"));
    assert!(!environment.variables().contains_key("\0PATH"));
}

#[cfg(not(windows))]
#[test]
fn posix_environment_keeps_variable_names_case_sensitive() {
    let environment = TerminalEnvironment::from_variables([
        ("PATH".into(), "/usr/bin".into()),
        ("Path".into(), "/untrusted".into()),
    ]);

    assert_eq!(environment.variables()["PATH"], "/usr/bin");
    assert!(!environment.variables().contains_key("Path"));
}

#[cfg(windows)]
#[test]
fn windows_environment_canonicalizes_variable_names() {
    let environment = TerminalEnvironment::from_variables([
        ("Path".into(), r"C:\Windows\System32".into()),
        ("SystemRoot".into(), r"C:\Windows".into()),
    ]);

    assert_eq!(environment.variables()["PATH"], r"C:\Windows\System32");
    assert_eq!(environment.variables()["SYSTEMROOT"], r"C:\Windows");
}
