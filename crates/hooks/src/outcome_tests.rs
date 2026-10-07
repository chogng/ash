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
