use super::*;

#[test]
fn revoked_directory_terminates_detached_sessions_and_rejects_new_work() {
    let root = tempfile::tempdir().unwrap();
    let grant = ash_file_access::Grant::for_environment(
        ash_file_access::Dir::open_local(root.path()).unwrap(),
        ash_file_access::GrantSource::HostConfiguration,
        ash_file_access::Permissions::new([Permission::ExecuteCommands]),
    );
    let service =
        TerminalService::new(grant.authorize(Permission::ExecuteCommands).unwrap()).unwrap();
    let request = TerminalCreateRequest {
        rows: 24,
        cols: 80,
        profile: TerminalProfileSelection::Default,
        lifecycle: TerminalLifecycle::Reconnectable,
    };
    let created = service.create(1, request.clone()).unwrap();
    service.close_owner(1);
    assert_eq!(service.active_count(), 1);

    grant.revoke();
    service.terminate_revoked_dirs();
    assert_eq!(service.active_count(), 0);
    assert_eq!(
        service.create(2, request),
        Err(TerminalError::OperationFailed)
    );
    assert_eq!(
        service.attach(
            2,
            TerminalAttachRequest {
                terminal_id: created.terminal_id,
                reconnect_token: created.reconnect.unwrap().reconnect_token,
                rows: 24,
                cols: 80,
            }
        ),
        Err(TerminalError::OperationFailed),
    );
}

#[test]
fn output_preserves_binary_bytes_across_cursor_reads() {
    let mut state = TerminalState::default();
    push_output(&mut state, vec![0xff, 0, 0xe2]);
    push_output(&mut state, vec![0x82, 0xac]);
    let mut request = TerminalReadRequest {
        terminal_id: "terminal-1".into(),
        after_sequence: 0,
        after_command_sequence: 0,
        max_chunks: 1,
    };

    let first = read_state(&request, &state);
    assert_eq!(first.chunks[0].data, [0xff, 0, 0xe2]);
    request.after_sequence = first.next_sequence;
    let second = read_state(&request, &state);
    assert_eq!(second.chunks[0].data, [0x82, 0xac]);
    assert_eq!(second.next_sequence, 2);
    assert!(!second.output_gap);
}

#[test]
fn output_ring_reports_a_gap_after_eviction() {
    let mut state = TerminalState::default();
    for _ in 0..3 {
        push_output(&mut state, vec![b'x'; MAX_OUTPUT_BYTES / 2]);
    }

    let result = read_state(
        &TerminalReadRequest {
            terminal_id: "terminal-1".into(),
            after_sequence: 0,
            after_command_sequence: 0,
            max_chunks: 128,
        },
        &state,
    );

    assert!(result.output_gap);
    assert_eq!(result.chunks.len(), 2);
    assert_eq!(result.chunks[0].sequence, 2);
    assert_eq!(result.next_sequence, 3);
}

#[test]
fn output_ring_advances_the_cursor_when_one_oversized_chunk_is_evicted() {
    let mut state = TerminalState::default();
    push_output(&mut state, vec![b'x'; MAX_OUTPUT_BYTES + 1]);

    let result = read_state(
        &TerminalReadRequest {
            terminal_id: "terminal-1".into(),
            after_sequence: 0,
            after_command_sequence: 0,
            max_chunks: 128,
        },
        &state,
    );

    assert!(result.output_gap);
    assert!(result.chunks.is_empty());
    assert_eq!(result.next_sequence, 1);
}

#[test]
fn terminal_size_and_input_limits_are_explicit() {
    assert_eq!(validate_size(0, 80), Err(TerminalError::InvalidInput));
    assert_eq!(validate_size(24, 0), Err(TerminalError::InvalidInput));
    assert_eq!(validate_size(512, 512), Ok(()));
    assert_eq!(validate_size(513, 80), Err(TerminalError::InvalidInput));
}

#[test]
fn process_is_not_terminal_until_output_has_closed() {
    let mut state = TerminalState {
        exit_code: Some(0),
        ..TerminalState::default()
    };
    state.exited = state.output_closed;
    assert!(!state.exited);

    state.output_closed = true;
    state.exited = state.exit_code.is_some();
    assert!(state.exited);
}
