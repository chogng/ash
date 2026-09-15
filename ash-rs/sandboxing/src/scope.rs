use crate::SandboxError;
use crate::filesystem::HostReadScope;
use crate::filesystem::ResolvedFileSystem;
use crate::filesystem::SandboxPathRule;
use ash_file_access::Dir;
use std::collections::BTreeSet;

/// Filesystem authority granted to one directory inside a sandboxed process.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SandboxDirAccess {
    ReadOnly,
    ReadWrite,
}

/// One exact directory and the maximum access a sandboxed process may receive for it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SandboxDirGrant {
    dir: Dir,
    access: SandboxDirAccess,
}

impl SandboxDirGrant {
    pub fn new(dir: Dir, access: SandboxDirAccess) -> Self {
        Self { dir, access }
    }

    pub fn dir(&self) -> &Dir {
        &self.dir
    }

    pub fn access(&self) -> SandboxDirAccess {
        self.access
    }
}

/// Exact directory visibility for one sandboxed process.
///
/// The host remains readable for toolchains except beneath `hidden_dirs`. Platform backends must
/// hide each of those directories and then reopen only the listed grants. This lets one process
/// use several owned roots without exposing sibling workspaces stored under the same parent.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SandboxScope {
    command_dir: Dir,
    grants: Vec<SandboxDirGrant>,
    hidden_dirs: Vec<Dir>,
    host_read: HostReadScope,
    path_rules: Vec<SandboxPathRule>,
    private_ipc_dirs: Vec<Dir>,
}

impl SandboxScope {
    pub fn single(command_dir: Dir) -> Self {
        Self {
            grants: vec![SandboxDirGrant::new(
                command_dir.clone(),
                SandboxDirAccess::ReadWrite,
            )],
            command_dir,
            hidden_dirs: Vec::new(),
            host_read: HostReadScope::Host,
            path_rules: Vec::new(),
            private_ipc_dirs: Vec::new(),
        }
    }

    pub fn new(
        command_dir: Dir,
        grants: Vec<SandboxDirGrant>,
        hidden_dirs: Vec<Dir>,
    ) -> Result<Self, SandboxError> {
        if grants.is_empty() {
            return Err(SandboxError::InvalidScope(
                "sandbox scope requires at least one directory grant".into(),
            ));
        }
        let environment = command_dir.env();
        if grants.iter().any(|grant| grant.dir().env() != environment)
            || hidden_dirs.iter().any(|dir| dir.env() != environment)
        {
            return Err(SandboxError::InvalidScope(
                "sandbox scope directories must belong to one environment".into(),
            ));
        }
        if !grants.iter().any(|grant| grant.dir() == &command_dir) {
            return Err(SandboxError::InvalidScope(
                "sandbox command directory is not granted".into(),
            ));
        }

        let mut grant_ids = BTreeSet::new();
        for grant in &grants {
            if !grant_ids.insert(grant.dir().id()) {
                return Err(SandboxError::InvalidScope(
                    "sandbox scope contains a duplicate directory grant".into(),
                ));
            }
        }
        for (index, left) in grants.iter().enumerate() {
            for right in grants.iter().skip(index + 1) {
                if left
                    .dir()
                    .canonical_path()
                    .starts_with(right.dir().canonical_path())
                    || right
                        .dir()
                        .canonical_path()
                        .starts_with(left.dir().canonical_path())
                {
                    return Err(SandboxError::InvalidScope(
                        "sandbox directory grants must not overlap".into(),
                    ));
                }
            }
        }

        let mut hidden_ids = BTreeSet::new();
        for hidden in &hidden_dirs {
            if !hidden_ids.insert(hidden.id()) {
                return Err(SandboxError::InvalidScope(
                    "sandbox scope contains a duplicate hidden directory".into(),
                ));
            }
            if grants.iter().any(|grant| {
                hidden
                    .canonical_path()
                    .starts_with(grant.dir().canonical_path())
            }) {
                return Err(SandboxError::InvalidScope(
                    "a hidden directory cannot be the same as or below a granted directory".into(),
                ));
            }
        }

        Ok(Self {
            command_dir,
            grants,
            hidden_dirs,
            host_read: HostReadScope::Host,
            path_rules: Vec::new(),
            private_ipc_dirs: Vec::new(),
        })
    }

    pub fn command_dir(&self) -> &Dir {
        &self.command_dir
    }

    pub fn grants(&self) -> &[SandboxDirGrant] {
        &self.grants
    }

    pub fn hidden_dirs(&self) -> &[Dir] {
        &self.hidden_dirs
    }

    pub fn with_host_read(mut self, host_read: HostReadScope) -> Self {
        self.host_read = host_read;
        self
    }

    pub fn host_read(&self) -> HostReadScope {
        self.host_read
    }

    pub fn with_path_rules(
        mut self,
        path_rules: Vec<SandboxPathRule>,
    ) -> Result<Self, SandboxError> {
        for rule in &path_rules {
            if !self.grants.iter().any(|grant| grant.dir() == rule.owner()) {
                return Err(SandboxError::InvalidScope(
                    "sandbox path rule owner must have an exact directory grant".into(),
                ));
            }
        }
        self.path_rules = path_rules;
        Ok(self)
    }

    pub fn path_rules(&self) -> &[SandboxPathRule] {
        &self.path_rules
    }

    pub fn with_private_ipc_dir(mut self, dir: Dir) -> Result<Self, SandboxError> {
        let mut grants = self.grants.clone();
        grants.push(SandboxDirGrant::new(
            dir.clone(),
            SandboxDirAccess::ReadWrite,
        ));
        let validated = Self::new(self.command_dir.clone(), grants, self.hidden_dirs.clone())?;
        self.grants = validated.grants;
        self.private_ipc_dirs.push(dir);
        Ok(self)
    }

    pub fn private_ipc_dirs(&self) -> &[Dir] {
        &self.private_ipc_dirs
    }

    pub fn resolve_filesystem(
        &self,
        access: crate::FileSystemAccess,
    ) -> Result<ResolvedFileSystem, SandboxError> {
        crate::filesystem::resolve(self, access)
    }

    /// Whether this scope grants only its command directory without hiding host directories.
    pub fn is_single_unhidden(&self) -> bool {
        self.hidden_dirs.is_empty()
            && self.path_rules.is_empty()
            && self.private_ipc_dirs.is_empty()
            && self.host_read == HostReadScope::Host
            && self.grants.len() == 1
            && self.grants[0].dir() == &self.command_dir
            && self.grants[0].access() == SandboxDirAccess::ReadWrite
    }
}

#[cfg(test)]
#[path = "scope_tests.rs"]
mod tests;
