//! Execution resources belong to the profile host and survive individual SSH connections.

use ash_app_server_daemon::ManagedConnection;
use exec_server::LocalEnvironment;
use exec_server_protocol::ExecError;
use exec_server_protocol::FileAccess;
use exec_server_protocol::NetworkAccess;
use exec_server_protocol::Response;
use std::collections::BTreeMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

#[derive(Default)]
pub(super) struct ExecutionRegistry {
    environments: Mutex<BTreeMap<String, Arc<LocalEnvironment>>>,
}

impl ExecutionRegistry {
    pub(super) fn serve(&self, mut connection: ManagedConnection, id: &str) -> Result<(), String> {
        let environment = match self.select(&connection.options, id) {
            Ok(environment) => environment,
            Err(error) => {
                serde_json::to_writer(&mut connection.writer, &Response::Error(error))
                    .map_err(|error| error.to_string())?;
                connection
                    .writer
                    .write_all(b"\n")
                    .map_err(|error| error.to_string())?;
                connection
                    .writer
                    .flush()
                    .map_err(|error| error.to_string())?;
                return Ok(());
            }
        };
        match exec_server::serve_authenticated_stream(
            connection.reader,
            connection.writer,
            &environment,
        ) {
            Ok(()) => Ok(()),
            Err(exec_server::Error::Transport(error))
                if super::is_peer_disconnect(&error)
                    || error.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                Ok(())
            }
            Err(error) => Err(error.to_string()),
        }
    }

    fn select(
        &self,
        options: &ash_app_server_daemon::ConnectionOptions,
        id: &str,
    ) -> Result<Arc<LocalEnvironment>, ExecError> {
        let root = options.dir_root().ok_or(ExecError::InvalidInput)?;
        let root = dunce::canonicalize(root).map_err(|_| ExecError::InvalidInput)?;
        let mut environments = self.environments.lock().map_err(|_| ExecError::Busy)?;
        if let Some(environment) = environments.get(id) {
            if PathBuf::from(&environment.info().root) != root {
                return Err(ExecError::Conflict);
            }
            return Ok(Arc::clone(environment));
        }
        if environments.len() >= 64 {
            return Err(ExecError::Busy);
        }
        let sandbox =
            exec_server::LocalSandbox::new(ash_install_context::InstallContext::current())
                .with_pty_helper(std::env::current_exe().map_err(|_| ExecError::Io)?)
                .build();
        let environment = Arc::new(
            LocalEnvironment::open(
                id.into(),
                &root,
                FileAccess::ReadWrite,
                NetworkAccess::Denied,
                Arc::new(sandbox),
            )
            .map_err(|error| match error {
                exec_server::Error::Remote(error) => error,
                exec_server::Error::Transport(_)
                | exec_server::Error::Protocol
                | exec_server::Error::OutcomeUnknown
                | exec_server::Error::FileNotPublished(_)
                | exec_server::Error::Cancelled(_) => ExecError::Io,
            })?,
        );
        environments.insert(id.into(), Arc::clone(&environment));
        Ok(environment)
    }

    pub(super) fn needs_host(&self) -> Result<bool, String> {
        for environment in self
            .environments
            .lock()
            .map_err(|_| "Execution registry lock poisoned")?
            .values()
        {
            if environment
                .has_active_processes()
                .map_err(|error| error.to_string())?
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub(super) fn stop(&self) -> Result<(), String> {
        for environment in self
            .environments
            .lock()
            .map_err(|_| "Execution registry lock poisoned")?
            .values()
        {
            environment
                .cancel_processes()
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}
