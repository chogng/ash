use std::collections::BTreeMap;
use std::path::Path;
use std::sync::RwLock;

use ash_file_access::Access;
use ash_file_access::AccessError;
use ash_file_access::Authorization;
use ash_file_access::Dir;
use ash_file_access::DirSource;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::Mutation;
use ash_file_access::Permission;
use ash_file_access::Permissions;
use ash_file_access::Snapshot;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;

/// App Server ownership of directory grants by Session tree or Thread subject.
#[derive(Default)]
pub(crate) struct DirGrants {
    session_trees: RwLock<BTreeMap<SessionId, Access>>,
    threads: RwLock<BTreeMap<ThreadId, ThreadDirs>>,
}

#[derive(Default)]
struct ThreadDirs {
    default: Option<Grant>,
}

#[derive(Clone, Debug)]
pub(crate) struct ThreadDirScope {
    authorization: Authorization,
}

impl ThreadDirScope {
    pub(crate) fn primary(&self) -> &Authorization {
        &self.authorization
    }

    pub(crate) fn authorizations(&self) -> impl Iterator<Item = &Authorization> {
        std::iter::once(&self.authorization)
    }
}

#[derive(Clone, Debug)]
pub(crate) struct DirGrantEntry {
    dir: Dir,
    permissions: Permissions,
}

impl DirGrantEntry {
    pub(crate) fn dir(&self) -> &Dir {
        &self.dir
    }

    pub(crate) fn permissions(&self) -> &Permissions {
        &self.permissions
    }
}

impl DirGrants {
    pub(crate) fn clear(&self) {
        self.session_trees
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
    }

    pub(crate) fn clear_session(&self, session_id: &SessionId) {
        self.session_trees
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(session_id);
    }

    pub(crate) fn bind_thread_dir(&self, thread_id: ThreadId, dir: Dir) {
        let mut threads = self
            .threads
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dirs = threads.entry(thread_id.clone()).or_default();
        if let Some(previous) = dirs.default.replace(Grant::for_thread(
            thread_id,
            dir,
            GrantSource::HostConfiguration,
            thread_dir_permissions(),
        )) {
            previous.revoke();
        }
    }

    pub(crate) fn unbind_thread_dir(&self, thread_id: &ThreadId) {
        let mut threads = self
            .threads
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(dirs) = threads.get_mut(thread_id) else {
            return;
        };
        if let Some(grant) = dirs.default.take() {
            grant.revoke();
        }
        threads.remove(thread_id);
    }

    /// Identifies the current Thread directory without granting filesystem access. Domain-specific
    /// consumers such as Memories must separately authorize their own scoped content.
    pub(crate) fn thread_dir_id(&self, thread_id: &ThreadId) -> Option<ash_file_access::DirId> {
        self.threads
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(thread_id)
            .and_then(|dirs| dirs.default.as_ref())
            .filter(|grant| grant.is_active())
            .map(|grant| grant.dir().id())
    }

    pub(crate) fn thread_scope(
        &self,
        thread_id: &ThreadId,
        permission: Permission,
    ) -> Result<Option<ThreadDirScope>, AccessError> {
        let threads = self
            .threads
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(dirs) = threads.get(thread_id) else {
            return Ok(None);
        };
        dirs.default
            .as_ref()
            .map(|grant| {
                grant
                    .authorize(permission)
                    .map(|authorization| ThreadDirScope { authorization })
            })
            .transpose()
            .map_err(|error| AccessError::PermissionUnavailable {
                dir: error.dir().canonical_path().to_path_buf(),
                permission,
            })
    }

    pub(crate) fn add_dir(
        &self,
        session_id: SessionId,
        grant: Grant,
    ) -> Result<Mutation, AccessError> {
        self.session_trees
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(session_id.clone())
            .or_insert_with(|| Access::new(ash_file_access::GrantSubject::SessionTree(session_id)))
            .add(grant, DirSource::SessionRequest)
    }

    pub(crate) fn remove_dir(&self, session_id: &SessionId, path: &Path) -> Mutation {
        let mut session_trees = self
            .session_trees
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(access) = session_trees.get_mut(session_id) else {
            return Mutation::NotPresent;
        };
        let Some(dir) = access.find(&ash_file_access::EnvId::local(), path) else {
            return Mutation::NotPresent;
        };
        access.remove(&dir, DirSource::SessionRequest)
    }

    pub(crate) fn list(&self, session_id: &SessionId) -> Vec<DirGrantEntry> {
        let session_trees = self
            .session_trees
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(access) = session_trees.get(session_id) else {
            return Vec::new();
        };
        access
            .dirs()
            .iter()
            .filter_map(|entry| {
                access
                    .permissions(entry.dir(), DirSource::SessionRequest)
                    .cloned()
                    .map(|permissions| DirGrantEntry {
                        dir: entry.dir().clone(),
                        permissions,
                    })
            })
            .collect()
    }

    pub(crate) fn revision(&self, session_id: &SessionId) -> u64 {
        self.session_trees
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(session_id)
            .map(|access| access.revision().get())
            .unwrap_or(0)
    }

    pub(crate) fn set_permissions(
        &self,
        session_id: &SessionId,
        path: &Path,
        expected_revision: u64,
        permissions: Permissions,
    ) -> Result<Mutation, AccessError> {
        let mut session_trees = self
            .session_trees
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(access) = session_trees.get_mut(session_id) else {
            if expected_revision == 0 {
                return Ok(Mutation::NotPresent);
            }
            return Err(AccessError::RevisionConflict {
                expected: expected_revision,
                actual: 0,
            });
        };
        let Some(dir) = access.find(&ash_file_access::EnvId::local(), path) else {
            return Ok(Mutation::NotPresent);
        };
        access.set_permissions(
            &dir,
            DirSource::SessionRequest,
            expected_revision,
            permissions,
        )
    }

    pub(crate) fn snapshot_for(
        &self,
        session_id: &SessionId,
        permission: Permission,
    ) -> Result<Option<Snapshot>, AccessError> {
        self.session_trees
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(session_id)
            .map(|access| access.snapshot(permission))
            .transpose()
    }

    pub(crate) fn dirs_for(
        &self,
        permission: Permission,
    ) -> std::collections::BTreeSet<std::path::PathBuf> {
        self.session_trees
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .filter_map(|access| access.snapshot(permission).ok())
            .flat_map(|snapshot| {
                snapshot
                    .authorizations()
                    .iter()
                    .filter(|authorization| authorization.ensure_active().is_ok())
                    .map(|authorization| authorization.dir().canonical_path().to_path_buf())
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    pub(crate) fn authorize(
        &self,
        session_id: &SessionId,
        path: &Path,
        permission: Permission,
    ) -> Result<Option<Authorization>, AccessError> {
        let session_trees = self
            .session_trees
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(access) = session_trees.get(session_id) else {
            return Ok(None);
        };
        let Some(dir) = access.find(&ash_file_access::EnvId::local(), path) else {
            return Ok(None);
        };
        access.authorize(&dir, permission).map(Some)
    }
}

fn thread_dir_permissions() -> Permissions {
    Permissions::new([
        Permission::ReadFiles,
        Permission::WriteFiles,
        Permission::BrowseFiles,
        Permission::ExecuteCommands,
        Permission::InspectRepository,
        Permission::MutateRepository,
    ])
}

impl ash_skills_extension::SessionSkillSourceProvider for DirGrants {
    fn snapshot(
        &self,
        session_id: &SessionId,
    ) -> Result<ash_skills_extension::DynamicSkillSourceSnapshot, String> {
        let generation = self.revision(session_id).max(1);
        let authorizations = self
            .snapshot_for(session_id, Permission::DiscoverSkills)
            .map_err(|error| error.to_string())?
            .into_iter()
            .flat_map(|snapshot| snapshot.authorizations().to_vec());
        let mut roots = Vec::new();
        for authorization in authorizations {
            authorization
                .ensure_active()
                .map_err(|error| error.to_string())?;
            let skill_root = authorization.dir().canonical_path().join(".ash/skills");
            if skill_root.is_dir() {
                let suffix = authorization
                    .dir()
                    .id()
                    .as_str()
                    .strip_prefix("sha256:")
                    .unwrap_or(authorization.dir().id().as_str())
                    .chars()
                    .take(16)
                    .collect::<String>();
                let id = ash_skills::SkillSourceId::new(format!("dir:skill-source:{suffix}"))
                    .map_err(|error| error.to_string())?;
                roots.push(
                    ash_skills::SkillSourceRoot::directory(id, skill_root)
                        .map_err(|error| error.to_string())?,
                );
            }
        }
        Ok(ash_skills_extension::DynamicSkillSourceSnapshot { generation, roots })
    }
}
