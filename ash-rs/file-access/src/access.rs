use crate::AccessError;
use crate::Authorization;
use crate::Dir;
use crate::DirEntry;
use crate::DirId;
use crate::DirSource;
use crate::EnvId;
use crate::Grant;
use crate::GrantSubject;
use crate::Mutation;
use crate::Permission;
use crate::Permissions;
use crate::Revision;
use crate::Snapshot;
use std::collections::BTreeMap;
use std::path::Path;

type SourceGrants = BTreeMap<DirSource, Grant>;

/// Mutable owner of a symmetric set of directory grants.
pub struct Access {
    subject: GrantSubject,
    dirs: Vec<DirEntry>,
    grants: BTreeMap<DirId, SourceGrants>,
    revision: Revision,
}

impl Access {
    pub fn new(subject: GrantSubject) -> Self {
        Self {
            subject,
            dirs: Vec::new(),
            grants: BTreeMap::new(),
            revision: Revision::default(),
        }
    }

    pub fn dirs(&self) -> &[DirEntry] {
        &self.dirs
    }

    pub fn revision(&self) -> Revision {
        self.revision
    }

    pub fn add(&mut self, grant: Grant, source: DirSource) -> Result<Mutation, AccessError> {
        if grant.subject() != &self.subject {
            return Err(AccessError::SubjectMismatch);
        }
        let dir = grant.dir().clone();
        if let Some(index) = self.dirs.iter().position(|entry| {
            entry.dir().env() == dir.env()
                && entry.dir().canonical_path() == dir.canonical_path()
                && entry.dir() != &dir
        }) {
            let previous = self.dirs.remove(index);
            if let Some(grants) = self.grants.remove(&previous.dir().id()) {
                for grant in grants.values() {
                    grant.revoke();
                }
            }
        }
        let mutation = if let Some(entry) = self.dirs.iter_mut().find(|entry| entry.dir() == &dir) {
            if entry.add_source(source) {
                Mutation::AddedSource
            } else {
                Mutation::AlreadyPresent
            }
        } else {
            self.dirs.push(DirEntry::new(dir.clone(), source));
            self.dirs.sort_by(|left, right| {
                left.dir()
                    .canonical_path()
                    .cmp(right.dir().canonical_path())
            });
            Mutation::AddedDir
        };
        if mutation.changes_scope() {
            self.grants
                .entry(dir.id())
                .or_default()
                .insert(source, grant);
            self.revision.advance();
        } else if self
            .grants
            .get(&dir.id())
            .and_then(|grants| grants.get(&source))
            .is_some_and(|existing| !existing.shares_lease(&grant))
        {
            grant.revoke();
        }
        Ok(mutation)
    }

    pub fn remove(&mut self, dir: &Dir, source: DirSource) -> Mutation {
        let Some(index) = self.dirs.iter().position(|entry| entry.dir() == dir) else {
            return Mutation::NotPresent;
        };
        if !self.dirs[index].remove_source(source) {
            return Mutation::NotPresent;
        }
        let canonical = dir.id();
        if let Some(source_grants) = self.grants.get_mut(&canonical) {
            if let Some(grant) = source_grants.remove(&source) {
                grant.revoke();
            }
            if source_grants.is_empty() {
                self.grants.remove(&canonical);
            }
        }
        let mutation = if self.dirs[index].has_no_sources() {
            self.dirs.remove(index);
            Mutation::RemovedDir
        } else {
            Mutation::RemovedSource
        };
        self.revision.advance();
        mutation
    }

    pub fn find(&self, env: &EnvId, path: &Path) -> Option<Dir> {
        self.dirs
            .iter()
            .find(|entry| {
                entry.dir().env() == env
                    && (entry.dir().requested_path() == path
                        || entry.dir().canonical_path() == path)
            })
            .map(|entry| entry.dir().clone())
    }

    pub fn permissions(&self, dir: &Dir, source: DirSource) -> Option<&Permissions> {
        self.grants
            .get(&dir.id())
            .and_then(|grants| grants.get(&source))
            .filter(|grant| grant.is_active())
            .map(Grant::permissions)
    }

    /// Decides only the requested directory, independently of unrelated revoked grants.
    pub fn authorize(
        &self,
        dir: &Dir,
        permission: Permission,
    ) -> Result<Authorization, AccessError> {
        self.grants
            .get(&dir.id())
            .into_iter()
            .flat_map(BTreeMap::values)
            .find_map(|grant| grant.authorize(permission).ok())
            .ok_or_else(|| AccessError::PermissionUnavailable {
                dir: dir.canonical_path().to_path_buf(),
                permission,
            })
    }

    pub fn set_permissions(
        &mut self,
        dir: &Dir,
        source: DirSource,
        expected_revision: u64,
        permissions: Permissions,
    ) -> Result<Mutation, AccessError> {
        if self.revision.get() != expected_revision {
            return Err(AccessError::RevisionConflict {
                expected: expected_revision,
                actual: self.revision.get(),
            });
        }
        let Some(grant) = self
            .grants
            .get_mut(&dir.id())
            .and_then(|grants| grants.get_mut(&source))
        else {
            return Ok(Mutation::NotPresent);
        };
        if grant.permissions() == &permissions {
            return Ok(Mutation::AlreadyPresent);
        }
        let replacement = Grant::new(
            grant.subject().clone(),
            grant.dir().clone(),
            grant.source(),
            permissions,
        );
        grant.revoke();
        *grant = replacement;
        self.revision.advance();
        Ok(Mutation::UpdatedPermissions)
    }

    pub fn snapshot(&self, permission: Permission) -> Result<Snapshot, AccessError> {
        let mut authorizations = Vec::with_capacity(self.dirs.len());
        for entry in &self.dirs {
            let grants = self
                .grants
                .get(&entry.dir().id())
                .into_iter()
                .flat_map(BTreeMap::values)
                .filter(|grant| grant.permissions().allows(permission))
                .collect::<Vec<_>>();
            if grants.is_empty() {
                continue;
            }
            let authorization = grants
                .into_iter()
                .find_map(|grant| grant.authorize(permission).ok())
                .ok_or_else(|| AccessError::PermissionUnavailable {
                    dir: entry.dir().canonical_path().to_path_buf(),
                    permission,
                })?;
            authorizations.push(authorization);
        }
        Ok(Snapshot::new(self.revision, authorizations))
    }
}

impl Drop for Access {
    fn drop(&mut self) {
        for grant in self.grants.values().flat_map(BTreeMap::values) {
            grant.revoke();
        }
    }
}

#[cfg(test)]
#[path = "access_tests.rs"]
mod tests;
