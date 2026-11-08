use super::*;

#[cfg(not(windows))]
#[test]
fn shell_review_separates_commands_and_literal_redirections() {
    let script = "git status && printf '%s' 'literal && >' 2>> 'out file'\npwd < input";
    assert_eq!(
        analyze("bash", &["-c".into(), script.into()]),
        ShellInvocation::Literal {
            commands: vec![
                ExecPolicyCommand::new("git", ["status".into()]),
                ExecPolicyCommand::new("printf", ["%s".into(), "literal && >".into()]),
                ExecPolicyCommand::new("pwd", []),
            ],
            redirects: vec![
                Redirect::Write("out file".into()),
                Redirect::Read("input".into())
            ],
            login_shell: false,
        }
    );
}

#[cfg(not(windows))]
#[test]
fn shell_review_covers_each_branch_of_pipelines_and_lists() {
    let script = "git status | cat || printf x; pwd";
    let ShellInvocation::Literal { commands, .. } = analyze("sh", &["-c".into(), script.into()])
    else {
        panic!("expected a literal compound command");
    };
    assert_eq!(
        commands
            .iter()
            .map(ExecPolicyCommand::program)
            .collect::<Vec<_>>(),
        ["git", "cat", "printf", "pwd"]
    );
}

#[test]
fn shell_review_refuses_unresolved_or_unmodeled_execution() {
    for script in [
        "git status && echo $(touch marker)",
        "git status > \"$target\"",
        "git status > *.txt",
        "git status 2>&1",
        "git status <<EOF\ninput\nEOF",
        "git status && sh -c 'touch marker'",
        "cd another && git status > result",
        "git status & pwd",
        "git status &&",
    ] {
        assert_eq!(
            analyze("bash", &["-c".into(), script.into()]),
            ShellInvocation::Opaque,
            "{script}"
        );
    }
    assert_eq!(
        analyze("pwsh", &["-Command".into(), "git status".into()]),
        ShellInvocation::Opaque
    );
    assert_eq!(
        analyze("/workspace/bash", &["-c".into(), "git status".into()]),
        ShellInvocation::Opaque
    );
    assert_eq!(
        analyze("git", &["status".into(), "&&".into()]),
        ShellInvocation::Direct
    );
}

#[test]
fn shell_review_reusable_prefix_accepts_only_vetted_arguments() {
    let status = ExecPolicyCommand::new("git", ["status".into()]);
    assert_eq!(
        session_prefix(&ExecPolicyCommand::new(
            "git",
            ["status".into(), "--short".into()]
        )),
        Some(status)
    );
    for arguments in [
        vec!["status", "--unknown"],
        vec!["status", "&&"],
        vec!["clean", "-fd"],
        vec!["-c", "alias.status=!touch x", "status"],
    ] {
        assert!(
            session_prefix(&ExecPolicyCommand::new(
                "git",
                arguments.into_iter().map(str::to_owned)
            ))
            .is_none()
        );
    }
}

#[cfg(unix)]
#[test]
fn shell_review_ignores_startup_code_overrides_for_literal_non_login_shells() {
    let mut environment =
        ash_tool_executor::CommandEnvironment(std::collections::BTreeMap::from([
            ("BASH_ENV".into(), "startup.sh".into()),
            ("BASH_FUNC_git%%".into(), "() { touch marker; }".into()),
            ("ENV".into(), "startup.sh".into()),
            ("PATH".into(), "/bin".into()),
        ]));
    filter_shell_startup(
        "bash",
        &["-c".into(), "git status".into()],
        &mut environment,
    );
    assert_eq!(
        environment.0,
        std::collections::BTreeMap::from([("PATH".into(), "/bin".into())])
    );
}
