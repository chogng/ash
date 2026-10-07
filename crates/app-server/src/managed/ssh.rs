//! SSH carriers owned by the shared backend, with an independent lifetime per connection.

use ash_app_server_daemon::ManagedConnection;
use ash_app_server_daemon::SshConnectionOptions;
use ash_app_server_transport::relay_output;
use std::io;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::net::Shutdown;
use std::process::Command;
use std::process::Stdio;
use std::sync::mpsc;
use std::thread;

pub(super) fn serve(
    mut connection: ManagedConnection,
    target: &SshConnectionOptions,
) -> io::Result<()> {
    let shutdown = connection.writer.try_clone()?;
    let executable = std::env::var_os("ASH_SSH_PATH").unwrap_or_else(|| "ssh".into());
    let mut child = Command::new(executable)
        .args([
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            target.host(),
        ])
        .arg(remote_command(target))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()?;
    let mut stdin = child.stdin.take().expect("SSH stdin is piped");
    let stdout = child.stdout.take().expect("SSH stdout is piped");
    // An SSH peer can stop reading or writing independently. Keep local reads separate from
    // blocked pipe writes, and bound the queued bytes so peer close can tear down the carrier.
    let (input, queued) = mpsc::sync_channel::<Vec<u8>>(8192);
    let (completed, completion) = mpsc::channel();
    thread::scope(|scope| {
        let input_done = completed.clone();
        scope.spawn(move || {
            let result = (|| {
                let mut buffer = [0; 8192];
                loop {
                    let length = connection.reader.read(&mut buffer)?;
                    if length == 0 {
                        return Ok(());
                    }
                    input
                        .try_send(buffer[..length].to_vec())
                        .map_err(|error| match error {
                            mpsc::TrySendError::Full(_) => io::Error::new(
                                io::ErrorKind::WouldBlock,
                                "SSH input byte capacity exhausted",
                            ),
                            mpsc::TrySendError::Disconnected(_) => io::ErrorKind::BrokenPipe.into(),
                        })?;
                }
            })();
            let _ = input_done.send(result);
        });
        let write_done = completed.clone();
        scope.spawn(move || {
            let result = (|| {
                while let Ok(bytes) = queued.recv() {
                    stdin.write_all(&bytes)?;
                    stdin.flush()?;
                }
                Ok(())
            })();
            let _ = write_done.send(result);
        });
        scope.spawn(move || {
            let result = relay_output(&mut BufReader::new(stdout), &mut connection.writer);
            let _ = completed.send(result);
        });
        let result = completion
            .recv()
            .map_err(|_| io::Error::other("SSH carrier workers closed"))?;
        let _ = shutdown.shutdown(Shutdown::Both);
        let _ = child.kill();
        let _ = child.wait();
        result
    })
}

fn remote_command(target: &SshConnectionOptions) -> String {
    let mut args = vec!["env".to_owned()];
    match target.root() {
        Some(root) => args.push(format!("ASH_WORKSPACE_ROOT={root}")),
        None => args.extend(["-u".into(), "ASH_WORKSPACE_ROOT".into()]),
    }
    args.extend([target.runtime().into(), "connect".into()]);
    args.into_iter()
        .map(|arg| format!("'{}'", arg.replace('\'', "'\\''")))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
#[path = "ssh_tests.rs"]
mod tests;
