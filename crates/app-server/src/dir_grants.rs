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
    requested: RwLock<Vec<RequestedGrant>>,
    approvals: RwLock<
        BTreeMap<
            SessionId,
            Vec<(
                ash_protocol::ActionProvenance,
                ash_protocol::ActionApprovalRequest,
            )>,
        >,
    >,
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
    permissions: Permissions,
}

impl ThreadDirScope {
    pub(crate) fn permissions(&self) -> &Permissions {
        &self.permissions
    }
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

struct RequestedGrant {
    session: SessionId,
    thread: ThreadId,
    turn: ash_protocol::TurnId,
    duration: ash_protocol::PermissionGrantDuration,
    directories: Vec<Grant>,
    network_hosts: Vec<String>,
}

impl Drop for RequestedGrant {
    fn drop(&mut self) {
        for grant in &self.directories {
            grant.revoke();
        }
    }
}

impl DirGrants {
    pub(crate) fn remember_approval(
        &self,
        session: SessionId,
        provenance: ash_protocol::ActionProvenance,
        request: ash_protocol::ActionApprovalRequest,
    ) -> Result<(), String> {
        let mut approvals = self
            .approvals
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let entries = approvals.entry(session).or_default();
        if entries.iter().any(|(source, entry)| {
            source == &provenance
                && entry.action_digest == request.action_digest
                && entry.policy_revision == request.policy_revision
                && entry.capabilities == request.capabilities
        }) {
            return Ok(());
        }
        if entries.len() >= 512 {
            return Err("too many reusable action approvals".into());
        }
        entries.push((provenance, request));
        Ok(())
    }

    pub(crate) fn has_approval(
        &self,
        session: &SessionId,
        provenance: &ash_protocol::ActionProvenance,
        request: &ash_protocol::ActionApprovalRequest,
    ) -> bool {
        self.approvals
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(session)
            .is_some_and(|entries| {
                entries.iter().any(|(source, entry)| {
                    source == provenance
                        && entry.action_digest == request.action_digest
                        && entry.policy_revision == request.policy_revision
                        && entry.capabilities == request.capabilities
                })
            })
    }

    pub(crate) fn grant_requested(
        &self,
        session: SessionId,
        thread: ThreadId,
        turn: ash_protocol::TurnId,
        response: &ash_protocol::PermissionResponse,
        bindings: &[Dir],
    ) -> Result<(), String> {
        if response
            .directories
            .iter()
            .all(|entry| entry.permissions.is_empty())
            && response.network_hosts.is_empty()
        {
            return Ok(());
        }
        let mut requested = self
            .requested
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if requested.len() >= 512 {
            return Err("too many live permission grants".into());
        }
        let directories = response
            .directories
            .iter()
            .filter(|entry| !entry.permissions.is_empty())
            .map(|entry| {
                // Keep the opened identity and original path spelling from before the approval wait.
                let dir = bindings
                    .iter()
                    .find(|dir| dir.canonical_path().to_string_lossy() == entry.path)
                    .ok_or_else(|| "approved directory has no matching host identity".to_owned())?
                    .clone();
                dir.directory()
                    .ensure_current()
                    .map_err(|error| error.to_string())?;
                let permissions = Permissions::new(entry.permissions.iter().copied());
                Ok(match response.duration {
                    ash_protocol::PermissionGrantDuration::Turn => Grant::for_turn(
                        thread.clone(),
                        turn.clone(),
                        dir,
                        GrantSource::ExplicitUser,
                        permissions,
                    ),
                    ash_protocol::PermissionGrantDuration::Session => Grant::for_session_tree(
                        session.clone(),
                        dir,
                        GrantSource::ExplicitUser,
                        permissions,
                    ),
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        requested.push(RequestedGrant {
            session,
            thread,
            turn,
            duration: response.duration,
            directories,
            network_hosts: response.network_hosts.clone(),
        });
        Ok(())
    }

    pub(crate) fn expire_turn(&self, thread: &ThreadId, turn: &ash_protocol::TurnId) {
        self.requested
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|grant| {
                grant.duration != ash_protocol::PermissionGrantDuration::Turn
                    || &grant.thread != thread
                    || &grant.turn != turn
            });
    }

    pub(crate) fn requested_authorizations(
        &self,
        session: &SessionId,
        thread: &ThreadId,
        turn: &ash_protocol::TurnId,
        permission: Permission,
    ) -> Vec<Authorization> {
        self.requested
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .filter(|grant| {
                &grant.session == session
                    && (grant.duration == ash_protocol::PermissionGrantDuration::Session
                        || (&grant.thread == thread && &grant.turn == turn))
            })
            .flat_map(|grant| {
                grant
                    .directories
                    .iter()
                    .filter_map(|directory| directory.authorize(permission).ok())
            })
            .collect()
    }

    pub(crate) fn has_requested_network(
        &self,
        session: &SessionId,
        thread: &ThreadId,
        turn: &ash_protocol::TurnId,
    ) -> bool {
        self.requested
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .any(|grant| {
                &grant.session == session
                    && (grant.duration == ash_protocol::PermissionGrantDuration::Session
                        || (&grant.thread == thread && &grant.turn == turn))
                    && !grant.network_hosts.is_empty()
            })
    }

    pub(crate) fn requested_network(
        &self,
        session: &SessionId,
        thread: &ThreadId,
        turn: &ash_protocol::TurnId,
        host: &str,
    ) -> bool {
        self.requested
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .any(|grant| {
                &grant.session == session
                    && (grant.duration == ash_protocol::PermissionGrantDuration::Session
                        || (&grant.thread == thread && &grant.turn == turn))
                    && grant.network_hosts.iter().any(|allowed| allowed == host)
            })
    }

    pub(crate) fn requested_context(
        &self,
        session: &SessionId,
        thread: &ThreadId,
    ) -> Vec<serde_json::Value> {
        self.requested.read().unwrap_or_else(std::sync::PoisonError::into_inner).iter()
            .filter(|grant| &grant.session == session && (grant.duration == ash_protocol::PermissionGrantDuration::Session || &grant.thread == thread))
            .take(64).map(|grant| serde_json::json!({"duration": grant.duration, "turn": grant.turn,
                "directories": grant.directories.iter().filter(|directory| directory.is_active()).map(|directory|
                    serde_json::json!({"path": directory.dir().canonical_path(), "permissions": directory.permissions()})).collect::<Vec<_>>(),
                "networkHosts": grant.network_hosts, "source": "requested-user-permission"})).collect()
    }

    pub(crate) fn clear(&self) {
        self.approvals
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        self.requested
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        self.session_trees
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
    }

    pub(crate) fn clear_session(&self, session_id: &SessionId) {
        self.approvals
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(session_id);
        self.requested
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|grant| &grant.session != session_id);
        self.session_trees
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(session_id);
    }

    /// Issues the host's working-copy capabilities for a managed Thread binding.
    /// Ordinary cwd changes and workspace folder selection must not use this grant-issuing path.
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
            thread_directory_capabilities(),
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
        self.thread_dir(thread_id).map(|dir| dir.id())
    }

    /// Returns execution location metadata. Callers must separately authorize any I/O.
    pub(crate) fn thread_dir(&self, thread_id: &ThreadId) -> Option<Dir> {
        self.threads
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(thread_id)
            .and_then(|dirs| dirs.default.as_ref())
            .filter(|grant| grant.is_active())
            .map(|grant| grant.dir().clone())
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
                    .map(|authorization| ThreadDirScope {
                        authorization,
                        permissions: grant.permissions().clone(),
                    })
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
        self.requested
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|grant| {
                &grant.session != session_id
                    || !grant.directories.iter().any(|entry| {
                        path == entry.dir().canonical_path() || path == entry.dir().requested_path()
                    })
            });
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
        let result = access.set_permissions(
            &dir,
            DirSource::SessionRequest,
            expected_revision,
            permissions,
        );
        if result.is_ok() {
            self.requested
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .retain(|grant| {
                    &grant.session != session_id
                        || !grant.directories.iter().any(|entry| entry.dir() == &dir)
                });
        }
        result
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

fn thread_directory_capabilities() -> Permissions {
    Permissions::new([
        Permission::ReadFiles,
        Permission::SearchFiles,
        Permission::BrowseFiles,
        Permission::WriteFiles,
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
