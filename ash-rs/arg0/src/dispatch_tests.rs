use super::dispatch;

#[test]
fn ordinary_product_commands_are_not_consumed() {
    for arguments in [vec![], vec!["--listen", "stdio://"], vec!["exec", "hello"]] {
        assert!(dispatch(arguments.into_iter().map(Into::into)).is_none());
    }
}

#[test]
fn malformed_pty_role_fails_before_reading_launch_authority() {
    assert_eq!(
        dispatch(["--ash-mxc-pty".into(), "unexpected".into()]),
        Some(Err("PTY helper accepts no arguments".into()))
    );
}
