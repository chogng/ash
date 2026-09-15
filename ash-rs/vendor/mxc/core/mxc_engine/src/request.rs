// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! Request construction controls used by embedding applications.
use crate::policy::HostFilesystemAccess;
use crate::policy::SandboxRequest;
use crate::Error;
use crate::ErrorCode;
use std::path::Path;
use std::path::PathBuf;

impl SandboxRequest {
    /// Encodes an argv vector for this request's backend, without shell expansion of arguments.
    pub fn set_command(&mut self, argv: &[String]) -> Result<&mut Self, Error> {
        self.inner.prepared_files = None;
        if argv.is_empty() || argv[0].is_empty() || argv.iter().any(|arg| arg.contains('\0')) {
            return Err(Error::new(
                ErrorCode::MalformedRequest,
                "invalid command arguments",
            ));
        }
        use wxc_common::cmdline::CommandLineContext;
        let context = CommandLineContext::for_backend(&self.inner.containment);
        let command = wxc_common::cmdline::cmdline_from_argv_for_context(argv, context)
            .map_err(|error| Error::new(ErrorCode::MalformedRequest, error.to_string()))?;
        self.inner.script_code = if matches!(context, CommandLineContext::PosixShell) {
            format!("exec {command}")
        } else {
            command
        };
        Ok(self)
    }

    /// Authorizes only scoped, temporary host ACL changes required by the requested filesystem policy.
    pub fn permit_host_acl_changes(&mut self, roots: &[PathBuf]) -> Result<&mut Self, Error> {
        self.inner.prepared_files = None;
        self.inner.host_acl_scope = Some(
            wxc_common::host_changes::HostAclScope::new(roots.iter().cloned())
                .map_err(|error| Error::new(ErrorCode::MalformedRequest, error.to_string()))?,
        );
        self.inner.policy.fallback.allow_dacl_mutation = true;
        self.inner.lifecycle.preserve_policy = false;
        Ok(self)
    }

    /// Refuses any backend that would modify host ACLs to implement this request.
    pub fn forbid_host_acl_changes(&mut self) -> &mut Self {
        self.inner.prepared_files = None;
        self.inner.host_acl_scope = Some(Default::default());
        self.inner.policy.fallback.allow_dacl_mutation = false;
        self
    }

    /// Binds Bubblewrap validation and launch to one caller-resolved executable.
    pub fn set_bubblewrap_executable(&mut self, executable: &Path) -> Result<&mut Self, Error> {
        let path = std::fs::canonicalize(executable)
            .map_err(|error| Error::new(ErrorCode::BackendUnavailable, error.to_string()))?;
        if !path.is_file() {
            return Err(Error::new(
                ErrorCode::BackendUnavailable,
                "Bubblewrap is not a regular file",
            ));
        }
        self.inner.bubblewrap_executable = Some(path);
        Ok(self)
    }

    /// Restricts pathname Unix sockets to execution-owned directories on Seatbelt.
    pub fn restrict_seatbelt_unix_sockets(&mut self, paths: Vec<String>) -> &mut Self {
        let seatbelt = self.inner.seatbelt.get_or_insert_with(Default::default);
        seatbelt.allow_unix_sockets = false;
        seatbelt.allowed_unix_socket_paths = paths;
        self
    }

    /// Set the host access ceiling without authorizing host ACL mutations.
    /// Windows roots are materialized only in a PSEC specification, never as
    /// legacy ACL targets or caller-delegated explicit path grants.
    pub fn set_host_filesystem(
        &mut self,
        access: HostFilesystemAccess,
    ) -> Result<&mut Self, Error> {
        self.inner.host_filesystem = Some(access);
        self.inner.prepared_files = None;
        self.inner.host_filesystem_roots.clear();
        for path in roots()? {
            let name = path
                .to_str()
                .ok_or_else(|| {
                    Error::new(
                        ErrorCode::MalformedRequest,
                        "host filesystem path is not Unicode",
                    )
                })?
                .to_owned();
            if self.inner.policy.readwrite_paths.contains(&name)
                || self.inner.policy.readonly_paths.contains(&name)
                || self.inner.policy.denied_paths.contains(&name)
            {
                continue;
            }
            #[cfg(windows)]
            self.inner.host_filesystem_roots.push(name);
            #[cfg(not(windows))]
            match access {
                HostFilesystemAccess::ReadOnly => self.inner.policy.readonly_paths.push(name),
                HostFilesystemAccess::ReadWrite => self.inner.policy.readwrite_paths.push(name),
            }
        }
        Ok(self)
    }

    /// Requires the Windows ProcessContainer request to use PSEC even when the
    /// caller intentionally omits a host-wide filesystem visibility ceiling.
    pub fn require_process_security_environment(&mut self) -> &mut Self {
        self.inner.require_process_security_environment = true;
        self.inner.prepared_files = None;
        self
    }

    /// Select a complete implementation without provisioning or starting a process.
    /// Spawn revalidates the selected implementation and never switches it after failure.
    pub fn prepare(&mut self) -> Result<&mut Self, Error> {
        #[cfg(windows)]
        if self.inner.containment == wxc_common::models::ContainmentBackend::ProcessContainer
            && (self.inner.host_filesystem.is_some()
                || self.inner.require_process_security_environment)
        {
            self.inner.prepared_files = Some(
                wxc_common::filesystem_object::FilesystemSnapshot::capture(
                    self.inner
                        .policy
                        .readwrite_paths
                        .iter()
                        .chain(&self.inner.policy.readonly_paths)
                        .chain(&self.inner.policy.denied_paths)
                        .map(PathBuf::from)
                        .chain(std::iter::once(PathBuf::from(
                            &self.inner.working_directory,
                        ))),
                )
                .map_err(|error| Error::new(ErrorCode::MalformedRequest, error.to_string()))?,
            );
            crate::dispatch::require_windows_psec(&self.inner).map_err(Error::from)?;
        }
        Ok(self)
    }
}

#[cfg(test)]
#[path = "request_tests.rs"]
mod tests;

#[cfg(not(windows))]
fn roots() -> Result<Vec<PathBuf>, Error> {
    Ok(vec![PathBuf::from("/")])
}

#[cfg(windows)]
fn roots() -> Result<Vec<PathBuf>, Error> {
    let mask = unsafe { windows::Win32::Storage::FileSystem::GetLogicalDrives() };
    if mask == 0 {
        return Err(Error::new(
            ErrorCode::BackendUnavailable,
            "could not enumerate host volumes",
        ));
    }
    let mut paths = Vec::new();
    for index in 0..26 {
        if mask & (1 << index) == 0 {
            continue;
        }
        let root = PathBuf::from(format!("{}:\\", char::from(b'A' + index)));
        match std::fs::read_dir(&root) {
            Ok(entries) => {
                paths.push(root);
                for entry in entries {
                    paths.push(
                        entry
                            .map_err(|error| {
                                Error::new(ErrorCode::BackendError, error.to_string())
                            })?
                            .path(),
                    );
                    if paths.len() > 4096 {
                        return Err(Error::new(
                            ErrorCode::MalformedRequest,
                            "host filesystem expansion exceeds 4096 paths",
                        ));
                    }
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::NotFound
                ) || matches!(error.raw_os_error(), Some(21 | 53 | 1201 | 1167)) => {}
            Err(error) => return Err(Error::new(ErrorCode::BackendError, error.to_string())),
        }
    }
    Ok(paths)
}
