use std::io::Write;
use std::num::NonZeroU16;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

use ash_remote_connections::RemoteConnectionCatalog;
use ash_remote_connections::RemoteConnectionName;
use ash_remote_connections::SshTunnelDiagnostics;
use ash_remote_connections::SshTunnelOptions;
use ash_remote_connections::select_available_loopback_port;
use ash_remote_host::RemoteTunnelStartup;
use ash_remote_host::wait_for_remote_tunnel;
use signal_hook::SigId;
use signal_hook::consts::SIGINT;
#[cfg(unix)]
use signal_hook::consts::SIGTERM;

use crate::remote_connection_cli::RemoteConnectionCommandParseError;
use crate::remote_connection_cli::load_connection;

const TUNNEL_PROCESS_POLL: Duration = Duration::from_millis(100);

pub(crate) struct RemoteTunnelCommand {
    name: RemoteConnectionName,
    remote_port: NonZeroU16,
    local_port: Option<NonZeroU16>,
    ssh_executable: Option<PathBuf>,
}

impl RemoteTunnelCommand {
    pub(crate) fn parse(
        name: RemoteConnectionName,
        mut arguments: std::vec::IntoIter<String>,
    ) -> Result<Self, RemoteConnectionCommandParseError> {
        let mut remote_port = None;
        let mut local_port = None;
        let mut ssh_executable = None;
        while let Some(argument) = arguments.next() {
            match argument.as_str() {
                "--remote-port" => set_unique(
                    &mut remote_port,
                    "--remote-port",
                    parse_port(
                        "--remote-port",
                        arguments.next().ok_or(
                            RemoteConnectionCommandParseError::MissingValue {
                                flag: "--remote-port",
                            },
                        )?,
                    )?,
                )?,
                "--local-port" => set_unique(
                    &mut local_port,
                    "--local-port",
                    parse_port(
                        "--local-port",
                        arguments.next().ok_or(
                            RemoteConnectionCommandParseError::MissingValue {
                                flag: "--local-port",
                            },
                        )?,
                    )?,
                )?,
                "--ssh" => set_unique(
                    &mut ssh_executable,
                    "--ssh",
                    PathBuf::from(arguments.next().ok_or(
                        RemoteConnectionCommandParseError::MissingValue { flag: "--ssh" },
                    )?),
                )?,
                "--help" | "-h" => {
                    return Err(RemoteConnectionCommandParseError::HelpRequested);
                }
                _ => {
                    return Err(RemoteConnectionCommandParseError::UnknownArgument(argument));
                }
            }
        }
        Ok(Self {
            name,
            remote_port: remote_port.ok_or(RemoteConnectionCommandParseError::RequiredOption {
                command: "tunnel",
                flag: "--remote-port",
            })?,
            local_port,
            ssh_executable,
        })
    }

    pub(crate) fn execute(
        self,
        catalog: &RemoteConnectionCatalog,
        output: &mut dyn Write,
    ) -> Result<(), String> {
        let entry = load_connection(catalog, &self.name)?;
        let local_port = match self.local_port {
            Some(port) => port,
            None => select_available_loopback_port().map_err(|error| error.to_string())?,
        };
        let mut options =
            SshTunnelOptions::new(entry.target().host().clone(), local_port, self.remote_port)
                .with_diagnostics(SshTunnelDiagnostics::InheritStderr);
        if let Some(executable) = self.ssh_executable {
            options = options.with_ssh_executable(executable);
        }
        let signals = TunnelSignals::register()?;
        let tunnel = options.start().map_err(|error| error.to_string())?;
        let mut tunnel = match wait_for_remote_tunnel(tunnel, || signals.requested())? {
            RemoteTunnelStartup::Ready(tunnel) => tunnel,
            RemoteTunnelStartup::Cancelled => return Ok(()),
        };
        if signals.requested() {
            return tunnel.stop().map_err(|error| error.to_string());
        }
        writeln!(
            output,
            "forwarding\t{}\t127.0.0.1:{}\t127.0.0.1:{}",
            self.name.as_str(),
            local_port,
            self.remote_port
        )
        .map_err(|error| format!("could not write Remote tunnel output: {error}"))?;
        output
            .flush()
            .map_err(|error| format!("could not flush Remote tunnel output: {error}"))?;
        loop {
            if signals.requested() {
                return tunnel.stop().map_err(|error| error.to_string());
            }
            match tunnel.try_wait().map_err(|error| error.to_string())? {
                Some(status) if status.success() => return Ok(()),
                Some(status) => return Err(format!("SSH tunnel exited with {status}")),
                None => std::thread::park_timeout(TUNNEL_PROCESS_POLL),
            }
        }
    }
}

fn parse_port(
    flag: &'static str,
    value: String,
) -> Result<NonZeroU16, RemoteConnectionCommandParseError> {
    value
        .parse::<u16>()
        .ok()
        .and_then(NonZeroU16::new)
        .ok_or(RemoteConnectionCommandParseError::InvalidPort { flag, value })
}

fn set_unique<T>(
    slot: &mut Option<T>,
    flag: &'static str,
    value: T,
) -> Result<(), RemoteConnectionCommandParseError> {
    if slot.replace(value).is_some() {
        return Err(RemoteConnectionCommandParseError::DuplicateOption(flag));
    }
    Ok(())
}

struct TunnelSignals {
    requested: Arc<AtomicBool>,
    registrations: Vec<SigId>,
}

impl TunnelSignals {
    fn register() -> Result<Self, String> {
        let requested = Arc::new(AtomicBool::new(false));
        let mut registrations = Vec::new();
        register_signal(SIGINT, &requested, &mut registrations)?;
        #[cfg(unix)]
        register_signal(SIGTERM, &requested, &mut registrations)?;
        Ok(Self {
            requested,
            registrations,
        })
    }

    fn requested(&self) -> bool {
        self.requested.load(Ordering::Relaxed)
    }
}

impl Drop for TunnelSignals {
    fn drop(&mut self) {
        for registration in self.registrations.drain(..) {
            signal_hook::low_level::unregister(registration);
        }
    }
}

fn register_signal(
    signal: i32,
    requested: &Arc<AtomicBool>,
    registrations: &mut Vec<SigId>,
) -> Result<(), String> {
    match signal_hook::flag::register(signal, Arc::clone(requested)) {
        Ok(registration) => {
            registrations.push(registration);
            Ok(())
        }
        Err(error) => {
            for registration in registrations.drain(..) {
                signal_hook::low_level::unregister(registration);
            }
            Err(format!(
                "could not register Remote tunnel shutdown: {error}"
            ))
        }
    }
}
