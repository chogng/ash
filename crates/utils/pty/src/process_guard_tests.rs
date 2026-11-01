use super::*;
use std::fs;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Stdio;
use std::thread;
use std::time::Duration;
use std::time::Instant;

struct Owner(std::process::Child);

impl Drop for Owner {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[derive(Clone, Copy, Debug)]
enum Scenario {
    Session,
    StoppedSession,
    ClosedStdio,
    StoppedPipe,
    ExitedPipeLeader,
}

fn fixture_directory() -> Option<PathBuf> {
    std::env::var_os("ASH_TEST_PROCESS_GUARD_DIRECTORY").map(PathBuf::from)
}

#[test]
fn guard_entry() {
    if fixture_directory().is_some() {
        // The test harness runs this on a worker thread, exercising a guard that
        // must exclude all of its own Linux tasks while it sweeps the session.
        run_process_guard().unwrap();
    }
}

#[test]
fn port_child() {
    let Some(directory) = fixture_directory() else {
        return;
    };
    let descendant = std::env::var_os("ASH_TEST_PROCESS_GUARD_DESCENDANT").is_some();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let name = if descendant { "descendant" } else { "leader" };
    fs::write(
        directory.join(format!("{name}.tmp")),
        format!("{} {}", std::process::id(), listener.local_addr().unwrap()),
    )
    .unwrap();
    fs::rename(directory.join(format!("{name}.tmp")), directory.join(name)).unwrap();
    if !descendant {
        let _child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "process_guard::tests::port_child", "--nocapture"])
            .env("ASH_TEST_PROCESS_GUARD_DESCENDANT", "1")
            .process_group(0)
            .spawn()
            .unwrap();
        if std::env::var_os("ASH_TEST_PROCESS_GUARD_EXIT_LEADER").is_some() {
            let deadline = Instant::now() + Duration::from_secs(5);
            while !directory.join("descendant").exists() {
                assert!(Instant::now() < deadline);
                thread::sleep(Duration::from_millis(10));
            }
            return;
        }
    }
    loop {
        thread::park();
    }
}

#[test]
fn owner_child() {
    let Some(directory) = fixture_directory() else {
        return;
    };
    if std::env::var_os("ASH_TEST_PROCESS_GUARD_CLOSE_STDIO").is_some() {
        for fd in 0..=2 {
            unsafe { libc::close(fd) };
        }
    }
    EXECUTABLE
        .set(GuardExecutable {
            program: CString::new(std::env::current_exe().unwrap().as_os_str().as_bytes()).unwrap(),
            arguments: [
                "--exact",
                "process_guard::tests::guard_entry",
                "--nocapture",
            ]
            .into_iter()
            .map(|arg| CString::new(arg).unwrap())
            .collect(),
        })
        .ok()
        .unwrap();
    if std::env::var_os("ASH_TEST_PROCESS_GUARD_PIPE").is_some() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let mut environment = std::collections::HashMap::from([(
            "ASH_TEST_PROCESS_GUARD_DIRECTORY".into(),
            directory.to_string_lossy().into_owned(),
        )]);
        if std::env::var_os("ASH_TEST_PROCESS_GUARD_EXIT_LEADER").is_some() {
            environment.insert("ASH_TEST_PROCESS_GUARD_EXIT_LEADER".into(), "1".into());
        }
        let _process = runtime
            .block_on(crate::spawn_pipe_process(
                std::env::current_exe().unwrap().to_str().unwrap(),
                &[
                    "--exact".into(),
                    "process_guard::tests::port_child".into(),
                    "--nocapture".into(),
                ],
                &directory,
                &environment,
                &None,
                &[],
            ))
            .unwrap();
        loop {
            thread::park();
        }
    }
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.args(["--exact", "process_guard::tests::port_child", "--nocapture"]);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::process_group::configure_command_session(&mut command);
    let _guard = configure_command_guard(&mut command).unwrap().unwrap();
    let _child = command.spawn().unwrap();
    loop {
        thread::park();
    }
}

#[test]
fn owner_death_reclaims_listeners_even_when_the_session_leader_is_stopped() {
    for scenario in [
        Scenario::Session,
        Scenario::StoppedSession,
        Scenario::ClosedStdio,
        Scenario::StoppedPipe,
        Scenario::ExitedPipeLeader,
    ] {
        let directory = std::env::temp_dir().join(format!(
            "ash-session-guard-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&directory).unwrap();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "process_guard::tests::owner_child",
                "--nocapture",
            ])
            .env("ASH_TEST_PROCESS_GUARD_DIRECTORY", &directory)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit());
        if matches!(scenario, Scenario::ClosedStdio) {
            command.env("ASH_TEST_PROCESS_GUARD_CLOSE_STDIO", "1");
        }
        if matches!(scenario, Scenario::StoppedPipe | Scenario::ExitedPipeLeader) {
            command.env("ASH_TEST_PROCESS_GUARD_PIPE", "1");
        }
        if matches!(scenario, Scenario::ExitedPipeLeader) {
            command.env("ASH_TEST_PROCESS_GUARD_EXIT_LEADER", "1");
        }
        let mut owner = Owner(command.spawn().unwrap());
        let deadline = Instant::now() + Duration::from_secs(10);
        while !directory.join("descendant").exists() {
            assert!(
                owner.0.try_wait().unwrap().is_none(),
                "fixture owner exited: {scenario:?}"
            );
            assert!(Instant::now() < deadline, "guarded child did not start");
            thread::sleep(Duration::from_millis(10));
        }
        let mut owned = Vec::new();
        for name in ["leader", "descendant"] {
            let contents = fs::read_to_string(directory.join(name)).unwrap();
            let (pid, address) = contents.split_once(' ').unwrap();
            owned.push((pid.parse::<i32>().unwrap(), address.to_owned()));
        }
        if matches!(scenario, Scenario::ExitedPipeLeader) {
            while TcpListener::bind(&owned[0].1).is_err() {
                assert!(Instant::now() < deadline);
                thread::sleep(Duration::from_millis(10));
            }
            assert!(
                TcpListener::bind(&owned[1].1).is_err(),
                "lease must preserve the background descendant after root exit"
            );
        }
        if matches!(
            scenario,
            Scenario::StoppedSession | Scenario::ClosedStdio | Scenario::StoppedPipe
        ) {
            assert_eq!(unsafe { libc::kill(owned[0].0, libc::SIGSTOP) }, 0);
        }
        owner.0.kill().unwrap();
        owner.0.wait().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        for (pid, address) in &owned {
            loop {
                if let Ok(listener) = TcpListener::bind(address) {
                    drop(listener);
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "guard left process {pid} listening on {address}: {scenario:?}"
                );
                thread::sleep(Duration::from_millis(10));
            }
        }
        let mut system = sysinfo::System::new();
        loop {
            system.refresh_processes_specifics(
                sysinfo::ProcessesToUpdate::All,
                true,
                sysinfo::ProcessRefreshKind::nothing().without_tasks(),
            );
            let live = system.processes().iter().any(|(pid, process)| {
                process.status() != sysinfo::ProcessStatus::Zombie
                    && unsafe { libc::getsid(pid.as_u32() as i32) } == owned[0].0
            });
            if !live {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "owned session still has live processes"
            );
            thread::sleep(Duration::from_millis(10));
        }
        fs::remove_dir_all(directory).unwrap();
    }
}
