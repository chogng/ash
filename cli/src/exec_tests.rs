use super::*;

#[test]
fn exec_arguments_default_to_a_safe_new_human_run() {
    let options = parse_exec_arguments(vec!["inspect".into(), "the directory".into()]).unwrap();
    assert_eq!(options.entry, HeadlessEntry::New);
    assert_eq!(options.prompt, "inspect the directory");
    assert_eq!(options.output, ExecOutputMode::Human);
    assert_eq!(
        options.approval,
        HeadlessApprovalMode::DenyInteractiveRequests
    );
}

#[test]
fn exec_arguments_parse_jsonl_resume_and_auto_review() {
    let options = parse_exec_arguments(vec![
        "--jsonl".into(),
        "--auto-review".into(),
        "--resume".into(),
        "session-1".into(),
        "thread-1".into(),
        "continue".into(),
    ])
    .unwrap();
    assert_eq!(
        options.entry,
        HeadlessEntry::Resume {
            session_id: SessionId::new("session-1").unwrap(),
            thread_id: ThreadId::new("thread-1").unwrap(),
        }
    );
    assert_eq!(options.output, ExecOutputMode::JsonLines);
    assert_eq!(options.approval, HeadlessApprovalMode::AutomaticReview);
}

#[test]
fn exec_arguments_reject_conflicting_authority_and_entry_modes() {
    assert!(
        parse_exec_arguments(vec![
            "--auto-review".into(),
            "--dangerously-bypass-permissions".into(),
            "task".into(),
        ])
        .is_err()
    );
    assert!(
        parse_exec_arguments(vec![
            "--resume".into(),
            "session-1".into(),
            "thread-1".into(),
            "--fork".into(),
            "session-1".into(),
            "thread-2".into(),
            "task".into(),
        ])
        .is_err()
    );
}

#[test]
fn exec_fork_and_prompt_separator_preserve_task_text() {
    let options = parse_exec_arguments(vec![
        "--fork".into(),
        "session-1".into(),
        "parent-1".into(),
        "--title".into(),
        "Fork title".into(),
        "--".into(),
        "--jsonl".into(),
        "is prompt text".into(),
    ])
    .unwrap();
    assert_eq!(
        options.entry,
        HeadlessEntry::Fork {
            session_id: SessionId::new("session-1").unwrap(),
            parent_thread_id: ThreadId::new("parent-1").unwrap(),
        }
    );
    assert_eq!(options.title, "Fork title");
    assert_eq!(options.output, ExecOutputMode::Human);
    assert_eq!(options.prompt, "--jsonl is prompt text");
}

#[test]
fn exec_validates_missing_values_duplicates_and_empty_tasks() {
    for arguments in [
        vec!["--title"],
        vec!["--resume", "session"],
        vec!["--jsonl", "--jsonl", "task"],
        vec!["--unknown", "task"],
        vec!["   "],
    ] {
        assert_eq!(
            parse_exec_arguments(arguments.into_iter().map(str::to_owned).collect())
                .err()
                .unwrap()
                .exit_code,
            2
        );
    }
    let options = parse_exec_arguments(vec!["task".into(), "--jsonl".into()]).unwrap();
    assert_eq!(options.output, ExecOutputMode::JsonLines);
}

fn parse_exec_arguments(arguments: Vec<String>) -> Result<HeadlessCliOptions, CliError> {
    use clap::Parser;
    let cli = crate::Cli::try_parse_from(
        ["ash".to_owned(), "exec".to_owned()]
            .into_iter()
            .chain(arguments),
    )
    .map_err(CliError::usage)?;
    let Some(crate::Command::Exec(options)) = cli.command else {
        unreachable!()
    };
    options.into_headless()
}
