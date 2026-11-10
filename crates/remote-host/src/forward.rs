use std::io::Read;
use std::io::Write;
use std::num::NonZeroU16;
use std::sync::mpsc;

use ash_remote::SshHost;
use ash_remote_host::RemoteTunnelEvent;
use ash_remote_host::RemoteTunnelHost;
use ash_remote_host::RemoteTunnelUpdate;
use serde_json::json;

enum Message {
    Tunnel(RemoteTunnelEvent),
    OwnerClosed,
}

pub(super) fn run(args: &[String]) -> Result<(), String> {
    let [host, remote_port, ssh_executable] = args else {
        return Err("expected forward <host> <remote-port> <ssh-executable>".into());
    };
    let host = SshHost::parse(host).map_err(|error| error.to_string())?;
    let remote_port = remote_port
        .parse::<NonZeroU16>()
        .map_err(|error| format!("invalid remote port: {error}"))?;
    if ssh_executable.trim().is_empty() || ssh_executable.chars().any(char::is_control) {
        return Err("invalid SSH executable".into());
    }

    let (send, receive) = mpsc::channel();
    let owner = send.clone();
    // The pipe is the owner's lease. EOF also covers an Electron crash.
    std::thread::Builder::new()
        .name("forward-owner".into())
        .spawn(move || {
            let _ = std::io::stdin().read(&mut [0]);
            let _ = owner.send(Message::OwnerClosed);
        })
        .map_err(|error| error.to_string())?;
    let mut host = RemoteTunnelHost::new(host, ssh_executable);
    host.start(remote_port, move |event| {
        let _ = send.send(Message::Tunnel(event));
    })?;

    let mut stdout = std::io::stdout().lock();
    while let Ok(Message::Tunnel(event)) = receive.recv() {
        host.handle_event(&event);
        let status = match event.update() {
            RemoteTunnelUpdate::Ready { local_port } => json!({
                "kind": "ready",
                "localPort": local_port.get(),
            }),
            RemoteTunnelUpdate::Recovering { .. } => json!({ "kind": "recovering" }),
            RemoteTunnelUpdate::Failed(message) => json!({ "kind": "failed", "message": message }),
            RemoteTunnelUpdate::Stopped => break,
        };
        writeln!(stdout, "{status}")
            .and_then(|()| stdout.flush())
            .map_err(|error| error.to_string())?;
        if event.update().is_terminal() {
            break;
        }
    }
    // Dropping the host stops and joins the worker before process exit.
    Ok(())
}
