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

#[test]
fn terminal_process_properties_follow_resize_and_reject_other_connections() {
    let root = tempfile::tempdir().unwrap();
    let service = terminal_service_for(root.path());
    let created = service
        .create(1, terminal_request(TerminalLifecycle::Reconnectable))
        .unwrap();
    assert!(created.ready.pid > 0);
    // Windows process paths can omit the extended-length prefix. The terminal
    // must still start in the exact filesystem directory that was authorized.
    assert_eq!(
        std::path::Path::new(&created.ready.cwd)
            .canonicalize()
            .unwrap(),
        root.path().canonicalize().unwrap()
    );
    assert_eq!(
        service.process_info(2, &created.terminal_id),
        Err(TerminalError::NotOwner)
    );
    assert_eq!(
        service.send_signal(2, &created.terminal_id, TerminalSignal::Interrupt),
        Err(TerminalError::NotOwner)
    );
    assert_eq!(
        service.write_binary(
            2,
            TerminalWriteBinaryRequest {
                terminal_id: created.terminal_id.clone(),
                data: vec![0xff]
            }
        ),
        Err(TerminalError::NotOwner)
    );
    for data in [vec![], vec![0xff; MAX_INPUT_BYTES + 1]] {
        assert_eq!(
            service.write_binary(
                1,
                TerminalWriteBinaryRequest {
                    terminal_id: created.terminal_id.clone(),
                    data
                }
            ),
            Err(TerminalError::InvalidInput)
        );
    }
    service
        .resize(
            1,
            TerminalResizeRequest {
                terminal_id: created.terminal_id.clone(),
                rows: 40,
                cols: 120,
            },
        )
        .unwrap();
    let info = service.process_info(1, &created.terminal_id).unwrap();
    assert_eq!((info.rows, info.cols), (40, 120));
    assert_eq!(info.ready, created.ready);
    service.close_owner(1);
    let attached = service
        .attach(
            2,
            TerminalAttachRequest {
                terminal_id: created.terminal_id.clone(),
                reconnect_token: created.reconnect.unwrap().reconnect_token,
                rows: 25,
                cols: 90,
            },
        )
        .unwrap();
    assert_eq!(attached.ready, created.ready);
    let info = service.process_info(2, &created.terminal_id).unwrap();
    assert_eq!((info.rows, info.cols), (25, 90));
    service.close(2, &created.terminal_id).unwrap();
    assert_eq!(
        service.process_info(2, &created.terminal_id),
        Err(TerminalError::NotFound)
    );
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn terminal_reports_shell_pid_and_real_cwd_after_cd() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("changed")).unwrap();
    let service = terminal_service_for(root.path());
    let created = service
        .create(1, terminal_request(TerminalLifecycle::ConnectionOwned))
        .unwrap();
    service
        .write(
            1,
            TerminalWriteRequest {
                terminal_id: created.terminal_id.clone(),
                data: "cd changed; printf '\\nROOT_PID:%s\\nCWD_READY\\n' \"$$\"\n".into(),
            },
        )
        .unwrap();
    let output = read_until(&service, &created.terminal_id, "CWD_READY\r\n");
    assert!(
        String::from_utf8_lossy(&output).contains(&format!("ROOT_PID:{}\r\n", created.ready.pid))
    );
    assert_eq!(
        service.process_info(1, &created.terminal_id).unwrap().cwd,
        Some(
            root.path()
                .join("changed")
                .canonicalize()
                .unwrap()
                .to_str()
                .unwrap()
                .to_owned()
        )
    );
    service.close(1, &created.terminal_id).unwrap();
}

#[cfg(unix)]
#[test]
fn terminal_binary_input_preserves_nul_and_non_utf8_bytes() {
    let root = tempfile::tempdir().unwrap();
    let service = terminal_service_for(root.path());
    let created = service
        .create(1, terminal_request(TerminalLifecycle::ConnectionOwned))
        .unwrap();
    service.write(1, TerminalWriteRequest { terminal_id: created.terminal_id.clone(), data: "stty -echo -icanon min 1 time 0; printf '\\nRAW_READY\\n'; dd bs=1 count=3 2>/dev/null | od -An -tx1; stty sane; printf '\\nRAW_DONE\\n'\n".into() }).unwrap();
    read_until(&service, &created.terminal_id, "RAW_READY\r\n");
    service
        .write_binary(
            1,
            TerminalWriteBinaryRequest {
                terminal_id: created.terminal_id.clone(),
                data: vec![0, 0x80, 0xff],
            },
        )
        .unwrap();
    let output = read_until(&service, &created.terminal_id, "RAW_DONE\r\n");
    assert!(
        String::from_utf8_lossy(&output)
            .lines()
            .any(|line| line.split_whitespace().collect::<Vec<_>>() == ["00", "80", "ff"]),
        "raw output: {:?}",
        String::from_utf8_lossy(&output)
    );
    service.close(1, &created.terminal_id).unwrap();
}

#[cfg(unix)]
#[test]
fn terminal_signal_interrupts_foreground_job_and_keeps_shell_alive() {
    let root = tempfile::tempdir().unwrap();
    let service = terminal_service_for(root.path());
    let created = service
        .create(1, terminal_request(TerminalLifecycle::ConnectionOwned))
        .unwrap();
    service
        .write(
            1,
            TerminalWriteRequest {
                terminal_id: created.terminal_id.clone(),
                data: "sh -c 'printf \"\\nSLEEP_READY\\n\"; exec sleep 60'\n".into(),
            },
        )
        .unwrap();
    read_until(&service, &created.terminal_id, "SLEEP_READY\r\n");
    service
        .send_signal(1, &created.terminal_id, TerminalSignal::Interrupt)
        .unwrap();
    service
        .write(
            1,
            TerminalWriteRequest {
                terminal_id: created.terminal_id.clone(),
                data: "printf '\\nSHELL_ALIVE\\n'\n".into(),
            },
        )
        .unwrap();
    read_until(&service, &created.terminal_id, "SHELL_ALIVE\r\n");
    assert_eq!(
        service
            .process_info(1, &created.terminal_id)
            .unwrap()
            .ready
            .pid,
        created.ready.pid
    );
    service.close(1, &created.terminal_id).unwrap();
}

#[cfg(windows)]
#[test]
fn terminal_signal_reports_unsupported_without_injecting_input() {
    let root = tempfile::tempdir().unwrap();
    let service = terminal_service_for(root.path());
    let created = service
        .create(1, terminal_request(TerminalLifecycle::ConnectionOwned))
        .unwrap();
    assert_eq!(
        service.send_signal(1, &created.terminal_id, TerminalSignal::Interrupt),
        Err(TerminalError::Unsupported)
    );
    assert_eq!(
        service.process_info(1, &created.terminal_id).unwrap().cwd,
        None
    );
    service.close(1, &created.terminal_id).unwrap();
}

fn terminal_service_for(path: &std::path::Path) -> TerminalService {
    let grant = ash_file_access::Grant::for_environment(
        ash_file_access::Dir::open_local(path).unwrap(),
        ash_file_access::GrantSource::HostConfiguration,
        ash_file_access::Permissions::new([Permission::ExecuteCommands]),
    );
    TerminalService::new(grant.authorize(Permission::ExecuteCommands).unwrap()).unwrap()
}

fn terminal_request(lifecycle: TerminalLifecycle) -> TerminalCreateRequest {
    TerminalCreateRequest {
        rows: 24,
        cols: 80,
        profile: TerminalProfileSelection::Default,
        lifecycle,
    }
}

#[cfg(unix)]
fn read_until(service: &TerminalService, terminal_id: &str, marker: &str) -> Vec<u8> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut output = Vec::new();
    while Instant::now() < deadline {
        let result = service
            .read(
                1,
                TerminalReadRequest {
                    terminal_id: terminal_id.to_owned(),
                    after_sequence: 0,
                    after_command_sequence: 0,
                    max_chunks: 128,
                },
            )
            .unwrap();
        output = result
            .chunks
            .into_iter()
            .flat_map(|chunk| chunk.data)
            .collect();
        if output
            .windows(marker.len())
            .any(|window| window == marker.as_bytes())
        {
            return output;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!(
        "terminal did not produce {marker:?}; output={:?}",
        String::from_utf8_lossy(&output)
    );
}
