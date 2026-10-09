use super::dispatch;

#[test]
fn ordinary_product_commands_are_not_consumed() {
    for arguments in [vec![], vec!["--listen", "stdio://"], vec!["exec", "hello"]] {
        assert!(dispatch(arguments.into_iter().map(Into::into)).is_none());
    }
}

#[test]
fn malformed_elevated_role_fails_before_connecting_to_a_socket() {
    for arguments in [
        vec!["--ash-elevated-file-write"],
        vec!["--ash-elevated-file-write", "0", "invalid"],
        vec!["--ash-elevated-file-write", "1", "invalid"],
    ] {
        assert!(matches!(
            dispatch(arguments.into_iter().map(Into::into)),
            Some(Err(_))
        ));
    }
}

#[cfg(windows)]
#[test]
fn malformed_pty_role_fails_before_reading_launch_authority() {
    assert_eq!(
        dispatch(["--ash-mxc-pty".into(), "unexpected".into()]),
        Some(Err("PTY helper accepts no arguments".into()))
    );
}

#[cfg(not(windows))]
#[test]
fn unix_has_no_pty_helper_role() {
    assert!(dispatch(["--ash-mxc-pty".into()]).is_none());
}
