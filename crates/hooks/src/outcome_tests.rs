use super::*;

fn output(stdout: &str) -> CommandOutput {
    CommandOutput {
        exit_code: Some(0),
        stdout: stdout.into(),
        stderr: String::new(),
        stdout_truncated: false,
        stderr_truncated: false,
    }
}

#[test]
fn empty_or_explicit_continue_output_proceeds() {
    assert_eq!(
        parse_output("user:hook:test", output("")),
        Ok(HookDecision::Continue)
    );
    assert_eq!(
        parse_output("user:hook:test", output(r#"{"decision":"continue"}"#)),
        Ok(HookDecision::Continue)
    );
}

#[test]
fn denial_requires_a_non_empty_reason() {
    assert_eq!(
        parse_output(
            "user:hook:test",
            output(r#"{"decision":"deny","reason":"blocked by dir rule"}"#)
        ),
        Ok(HookDecision::Deny {
            reason: "blocked by dir rule".into(),
        })
    );
    assert!(
        parse_output(
            "user:hook:test",
            output(r#"{"decision":"deny","reason":""}"#)
        )
        .is_err()
    );
}

#[test]
fn malformed_or_truncated_output_fails_closed() {
    assert!(parse_output("user:hook:test", output("not-json")).is_err());
    let mut truncated = output(r#"{"decision":"continue"}"#);
    truncated.stdout_truncated = true;
    assert!(parse_output("user:hook:test", truncated).is_err());
}

#[test]
fn claude_pre_tool_use_honors_denial_and_rejects_unsupported_authority_changes() {
    let id = "user:hook:claude";
    let mut blocked = output("");
    blocked.exit_code = Some(2);
    blocked.stderr = "Denied by the external hook".into();
    assert_eq!(
        parse_claude_pre_tool_use(id, blocked),
        Ok(HookDecision::Deny {
            reason: "Denied by the external hook".into()
        })
    );
    assert_eq!(
        parse_claude_pre_tool_use(
            id,
            output(
                r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}"#
            )
        ),
        Ok(HookDecision::Continue)
    );
    assert!(parse_claude_pre_tool_use(id, output(r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{}}}"#)).is_err());
    assert!(parse_claude_pre_tool_use(id, output(r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask"}}"#)).is_err());
}
