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

#[cfg(unix)]
#[test]
fn interactive_shell_commands_report_real_boundaries_and_keep_user_configuration() {
    const CHILD: &str = "ASH_SHELL_STATUS_TEST_PROFILE";
    let Ok(profile_id) = std::env::var(CHILD) else {
        let current = std::thread::current();
        let profiles = TerminalProfileCatalog::discover().list();
        for profile in profiles
            .iter()
            .filter(|profile| matches!(profile.profile_id.as_str(), "zsh" | "bash"))
        {
            let home = tempfile::tempdir().unwrap();
            std::fs::create_dir(home.path().join("startup")).unwrap();
            std::fs::create_dir(home.path().join("configured")).unwrap();
            std::fs::write(
                home.path().join("startup/.zshenv"),
                "export ZDOTDIR=\"$HOME/configured\"\n",
            )
            .unwrap();
            std::fs::write(home.path().join("configured/.zshrc"), "PS1='ASH_PROMPT> '; PS2='ASH_CONTINUE> '; export ASH_RC_LOADED=yes\nprecmd() { return 0; }\nuser_precmd() { printf '%s\\n' \"$?\" >> \"$HOME/prompt-status\"; }\nprecmd_functions=(user_precmd)\n").unwrap();
            std::fs::write(home.path().join(".bashrc"), "PS1='ASH_PROMPT> '; PS2='ASH_CONTINUE> '; export ASH_RC_LOADED=yes\nPROMPT_COMMAND='printf \"%s\\n\" \"$?\" >> \"$HOME/prompt-status\"'\n").unwrap();
            // A child test process isolates HOME/ZDOTDIR from parallel tests.
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", current.name().unwrap(), "--nocapture"])
                .env(CHILD, &profile.profile_id)
                .env("HOME", home.path())
                .env("ZDOTDIR", home.path().join("startup"))
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}: {output:?}",
                profile.profile_id
            );
            if profile.profile_id == "bash" {
                let rc = home.path().join(".bashrc");
                let mut script = std::fs::read_to_string(&rc).unwrap();
                script.push_str("trap 'printf debug >> \"$HOME/debug-calls\"' DEBUG\n");
                std::fs::write(rc, script).unwrap();
                let output = std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", current.name().unwrap(), "--nocapture"])
                    .env(CHILD, "bash")
                    .env("ASH_SHELL_STATUS_TEST_DEBUG", "1")
                    .env("HOME", home.path())
                    .output()
                    .unwrap();
                assert!(output.status.success(), "user DEBUG trap: {output:?}");
            }
        }
        assert!(profiles.iter().any(|profile| profile.profile_id == "bash"));
        return;
    };
    let root = tempfile::tempdir().unwrap();
    let service = terminal_service_for(root.path());
    let created = service
        .create(
            1,
            TerminalCreateRequest {
                profile: TerminalProfileSelection::Profile {
                    profile_id: profile_id.clone(),
                },
                ..terminal_request(TerminalLifecycle::ConnectionOwned)
            },
        )
        .unwrap();
    let id = &created.terminal_id;
    read_until(&service, id, "ASH_PROMPT> ");
    assert!(shell_status(&service, id).command_events.is_empty());

    if std::env::var_os("ASH_SHELL_STATUS_TEST_DEBUG").is_some() {
        let path = std::path::Path::new(&std::env::var("HOME").unwrap()).join("debug-calls");
        let initial_debug_calls = std::fs::read(&path).unwrap().len();
        let initial = shell_status(&service, id).next_sequence;
        write_shell(&service, id, "false\n");
        wait_shell_output(&service, id, initial);
        let result = shell_status(&service, id);
        // PS0 remains usable with an existing DEBUG trap; older Bash leaves
        // command detection unavailable instead of disturbing that trap.
        if result.command_events.len() == 2 {
            assert_eq!(
                result.command_events[1].status,
                TerminalCommandStatus::Failed
            );
        } else {
            assert!(result.command_events.is_empty(), "{result:?}");
        }
        let debug_calls = std::fs::read(path).unwrap();
        assert!(debug_calls.len() > initial_debug_calls);
        assert!(debug_calls.ends_with(b"debug"));
        service.close(1, id).unwrap();
        return;
    }

    write_shell(&service, id, "printf '%s\\n' \\\n");
    read_until(&service, id, "ASH_CONTINUE> ");
    assert!(shell_status(&service, id).command_events.is_empty());
    write_shell(&service, id, "\"CONFIG:$ASH_RC_LOADED\"\n");
    wait_shell_events(&service, id, 2);
    read_until(&service, id, "CONFIG:yes\r\n");
    let success = shell_status(&service, id);
    assert_eq!(
        success.command_events[1].status,
        TerminalCommandStatus::Succeeded
    );
    assert_eq!(success.command_events[1].exit_code, Some(0));
    let prompt_sequence = success.next_sequence;
    write_shell(&service, id, "\n");
    wait_shell_output(&service, id, prompt_sequence);
    assert_eq!(shell_status(&service, id).command_events.len(), 2);

    write_shell(&service, id, "false\n");
    wait_shell_events(&service, id, 4);
    let failure = shell_status(&service, id);
    assert_eq!(
        failure.command_events[3].status,
        TerminalCommandStatus::Failed
    );
    assert_eq!(failure.command_events[3].exit_code, Some(1));
    let statuses = std::fs::read_to_string(
        std::path::Path::new(&std::env::var("HOME").unwrap()).join("prompt-status"),
    )
    .unwrap();
    assert_eq!(statuses.lines().last(), Some("1"));

    write_shell(
        &service,
        id,
        "printf '\\nASH_READ_READY\\n'; read answer; printf '\\nANSWER:%s\\n' \"$answer\"\n",
    );
    read_until(&service, id, "ASH_READ_READY\r\n");
    assert_eq!(shell_status(&service, id).command_events.len(), 5);
    write_shell(&service, id, "inside-program\n");
    wait_shell_events(&service, id, 6);
    read_until(&service, id, "ANSWER:inside-program\r\n");

    write_shell(&service, id, "sleep 60\n");
    wait_shell_events(&service, id, 7);
    write_shell(&service, id, "\u{3}");
    wait_shell_events(&service, id, 8);
    let interrupted = shell_status(&service, id);
    assert_eq!(
        interrupted.command_events[7].status,
        TerminalCommandStatus::Failed
    );
    assert_ne!(interrupted.command_events[7].exit_code, Some(0));
    assert!(!interrupted.exited);
    let bytes = interrupted
        .chunks
        .into_iter()
        .flat_map(|chunk| chunk.data)
        .collect::<Vec<_>>();
    assert!(
        !bytes
            .windows(6)
            .any(|bytes| bytes == b"]633;C" || bytes == b"]633;D")
    );
    write_shell(&service, id, "printf '\\nASH_EXIT_OUTPUT\\n'; exit 17\n");
    wait_shell_events(&service, id, 10);
    let mut exited = shell_status(&service, id);
    assert!(exited.exited);
    assert_eq!(exited.command_events[9].exit_code, Some(17));
    // Command events can describe output beyond the current bounded read page.
    while exited.next_sequence < exited.command_events[9].after_output_sequence {
        let page = service
            .read(
                1,
                TerminalReadRequest {
                    terminal_id: id.into(),
                    after_sequence: exited.next_sequence,
                    after_command_sequence: exited.next_command_sequence,
                    max_chunks: 128,
                },
            )
            .unwrap();
        assert!(!page.chunks.is_empty());
        exited.next_sequence = page.next_sequence;
        exited.chunks.extend(page.chunks);
    }
    assert_eq!(
        exited.command_events[9].after_output_sequence,
        exited.next_sequence
    );
    let output = exited
        .chunks
        .into_iter()
        .flat_map(|chunk| chunk.data)
        .collect::<Vec<_>>();
    assert!(String::from_utf8_lossy(&output).contains("ASH_EXIT_OUTPUT\r\n"));
    service.close(1, id).unwrap();
}

#[cfg(unix)]
fn write_shell(service: &TerminalService, terminal_id: &str, data: &str) {
    service
        .write(
            1,
            TerminalWriteRequest {
                terminal_id: terminal_id.into(),
                data: data.into(),
            },
        )
        .unwrap();
}

#[cfg(unix)]
fn shell_status(service: &TerminalService, terminal_id: &str) -> TerminalReadResult {
    service
        .read(
            1,
            TerminalReadRequest {
                terminal_id: terminal_id.into(),
                after_sequence: 0,
                after_command_sequence: 0,
                max_chunks: 128,
            },
        )
        .unwrap()
}

#[cfg(unix)]
fn wait_shell_events(service: &TerminalService, terminal_id: &str, count: usize) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let result = shell_status(service, terminal_id);
        if result.command_events.len() >= count {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "expected {count} events: {result:?}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(unix)]
fn wait_shell_output(service: &TerminalService, terminal_id: &str, after_sequence: u64) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let result = service
            .read(
                1,
                TerminalReadRequest {
                    terminal_id: terminal_id.into(),
                    after_sequence,
                    after_command_sequence: 0,
                    max_chunks: 128,
                },
            )
            .unwrap();
        if result
            .chunks
            .iter()
            .flat_map(|chunk| &chunk.data)
            .copied()
            .collect::<Vec<_>>()
            .windows(12)
            .any(|bytes| bytes == b"ASH_PROMPT> ")
        {
            return;
        }
        assert!(Instant::now() < deadline, "no new prompt: {result:?}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(unix)]
#[test]
fn powershell_host_reports_commands_and_preserves_profile_hooks() {
    const CHILD: &str = "ASH_TEST_POWERSHELL_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let Ok(program) = std::env::var("ASH_TEST_POWERSHELL") else {
            println!("PowerShell PTY test requires ASH_TEST_POWERSHELL on Unix");
            return;
        };
        let home = tempfile::tempdir().unwrap();
        let configuration = home.path().join(".config/powershell");
        std::fs::create_dir_all(&configuration).unwrap();
        std::fs::write(
            configuration.join("Microsoft.PowerShell_profile.ps1"),
            r#"
Import-Module PSReadLine
$global:AshTestReadLine = $function:PSConsoleHostReadLine
function global:PSConsoleHostReadLine {
    Add-Content -LiteralPath "$HOME/readline-calls" -Value 'read'
    $global:AshTestReadLine.Invoke()
}
function global:prompt {
    $wasSuccessful = $?
    Add-Content -LiteralPath "$HOME/prompt-status" -Value $wasSuccessful
    'ASH_PS_PROMPT> '
}
"#,
        )
        .unwrap();
        let current = std::thread::current();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", current.name().unwrap(), "--nocapture"])
            .env(CHILD, "1")
            .env("SHELL", program)
            .env("HOME", home.path())
            .env("XDG_CONFIG_HOME", home.path().join(".config"))
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let service = terminal_service_for(root.path());
    let created = service
        .create(1, terminal_request(TerminalLifecycle::ConnectionOwned))
        .unwrap();
    assert_eq!(created.profile.profile_id, "powershell");
    let id = &created.terminal_id;
    let mut observed = PowerShellObservation::default();
    observed.wait_for(&service, id, |state| state.prompt_count() >= 1);
    assert!(observed.events.is_empty());

    write_shell(&service, id, "Write-Output (\r");
    observed.wait_for(&service, id, |state| {
        state.bytes.windows(2).any(|bytes| bytes == b">>")
    });
    assert!(observed.events.is_empty());
    write_shell(&service, id, "'ASH_PS_READY')\r");
    observed.wait_for(&service, id, |state| {
        state.events.len() == 2 && state.prompt_count() >= 2
    });
    assert_eq!(observed.events[1].status, TerminalCommandStatus::Succeeded);
    assert!(String::from_utf8_lossy(&observed.bytes).contains("ASH_PS_READY\r\n"));

    write_shell(&service, id, "Write-Error 'expected failure'\r");
    observed.wait_for(&service, id, |state| {
        state.events.len() == 4 && state.prompt_count() >= 3
    });
    assert_eq!(observed.events[3].status, TerminalCommandStatus::Failed);
    let home = std::env::var("HOME").unwrap();
    let statuses =
        std::fs::read_to_string(std::path::Path::new(&home).join("prompt-status")).unwrap();
    assert_eq!(statuses.lines().last(), Some("False"));

    let prompts = observed.prompt_count();
    write_shell(&service, id, "\r");
    observed.wait_for(&service, id, |state| state.prompt_count() > prompts);
    assert_eq!(observed.events.len(), 4);

    write_shell(
        &service,
        id,
        "$global:LASTEXITCODE = 7; Write-Output ('ASH_PS_' + 'SUCCESS')\r",
    );
    observed.wait_for(&service, id, |state| {
        state.events.len() == 6 && state.prompt_count() >= 5
    });
    assert_eq!(observed.events[5].status, TerminalCommandStatus::Succeeded);
    assert_eq!(observed.events[5].exit_code, Some(0));
    let calls =
        std::fs::read_to_string(std::path::Path::new(&home).join("readline-calls")).unwrap();
    assert!(calls.lines().count() >= 4);
    service.close(1, id).unwrap();
}

#[cfg(unix)]
#[derive(Default)]
struct PowerShellObservation {
    bytes: Vec<u8>,
    events: Vec<TerminalCommandStatusEvent>,
    output_sequence: u64,
    command_sequence: u64,
    cursor_replies: usize,
}

#[cfg(unix)]
impl PowerShellObservation {
    fn prompt_count(&self) -> usize {
        self.bytes
            .windows(15)
            .filter(|bytes| *bytes == b"ASH_PS_PROMPT> ")
            .count()
    }

    fn wait_for(
        &mut self,
        service: &TerminalService,
        terminal_id: &str,
        ready: impl Fn(&Self) -> bool,
    ) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let result = service
                .read(
                    1,
                    TerminalReadRequest {
                        terminal_id: terminal_id.into(),
                        after_sequence: self.output_sequence,
                        after_command_sequence: self.command_sequence,
                        max_chunks: 128,
                    },
                )
                .unwrap();
            self.output_sequence = result.next_sequence;
            self.command_sequence = result.next_command_sequence;
            self.bytes
                .extend(result.chunks.into_iter().flat_map(|chunk| chunk.data));
            self.events.extend(result.command_events);
            // PSReadLine queries cursor position; xterm supplies these replies in the product.
            let requests = self
                .bytes
                .windows(4)
                .filter(|bytes| *bytes == b"\x1b[6n")
                .count();
            while self.cursor_replies < requests {
                service
                    .write_binary(
                        1,
                        TerminalWriteBinaryRequest {
                            terminal_id: terminal_id.into(),
                            data: b"\x1b[1;1R".to_vec(),
                        },
                    )
                    .unwrap();
                self.cursor_replies += 1;
            }
            if ready(self) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "PowerShell output: {:?}; events: {:?}",
                String::from_utf8_lossy(&self.bytes),
                self.events
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
