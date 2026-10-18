//! Listener-owned Web workspace capabilities, independent of cached Desktop directory runtimes.

use super::AppServer;
use super::environment_runtime::EnvRuntimeError;
use super::fs_watcher::FileSystemWatcher;
use ash_app_server_protocol::WebWorkspaceFolder;
use ash_app_server_protocol::WebWorkspaceState;
use ash_app_server_protocol::protocol::fs::FsDirectoryTarget;
use ash_app_server_protocol::protocol::fs::FsResolvePathResult;
use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::PathAccessPolicy;
use ash_file_access::Permission;
use ash_file_access::Permissions;
use ash_file_system::ExactFileSystem;
use ash_file_system::FileSystem;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

const CONFIGURATION_ROUTE: &str = "web-workspace-configuration";

pub(crate) struct WebWorkspaceRollback {
    dirs: Vec<(String, Grant)>,
    configuration: Option<ConfigurationRollback>,
}

impl Drop for WebWorkspaceRollback {
    fn drop(&mut self) {
        for (_, grant) in &self.dirs {
            grant.revoke();
        }
    }
}

struct ConfigurationRollback {
    path: PathBuf,
    grant: Grant,
}

impl Drop for ConfigurationRollback {
    fn drop(&mut self) {
        self.grant.revoke();
    }
}

pub(super) struct ConfigurationFile {
    path: PathBuf,
    grant: Grant,
    ceiling: Permissions,
    files: Arc<dyn FileSystem>,
    _watcher: Option<FileSystemWatcher>,
    authority: Option<Arc<ash_config::ConfigStore>>,
}

impl ConfigurationFile {
    pub(super) fn reconcile(
        slot: &std::sync::RwLock<Option<Self>>,
        config: &ash_config::ResolvedConfig,
        updates: &Arc<super::update_broker::UpdateBroker>,
    ) -> Result<(), EnvRuntimeError> {
        let mut slot = slot
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(file) = slot.as_ref() else {
            return Ok(());
        };
        if file.grant.source() != GrantSource::ExplicitUser {
            return Ok(());
        }
        let configured = config
            .directory_grants
            .explicit_permissions_for(&file.grant.dir().id())
            .cloned()
            .unwrap_or_else(super::environment_runtime::inspection_permissions);
        let permissions = Permissions::new(
            file.ceiling
                .entries()
                .filter(|permission| configured.allows(*permission)),
        );
        if file.grant.is_active() && file.grant.permissions() == &permissions {
            return Ok(());
        }
        // Revoke the old operation handles first, including a removed-root configuration whose
        // narrower lease deliberately survived Workspace removal. User revocation still wins.
        file.grant.revoke();
        if !permissions.allows(Permission::ReadFiles)
            || !permissions.allows(Permission::BrowseFiles)
        {
            return Ok(());
        }
        let grant = Grant::for_environment(
            file.grant.dir().clone(),
            GrantSource::ExplicitUser,
            permissions,
        )
        .with_path_policy(file.grant.path_policy().clone());
        let mut next = Self::open(file.path.clone(), grant, updates, file.authority.clone())?;
        next.ceiling = file.ceiling.clone();
        *slot = Some(next);
        Ok(())
    }

    fn open(
        path: PathBuf,
        grant: Grant,
        updates: &Arc<super::update_broker::UpdateBroker>,
        authority: Option<Arc<ash_config::ConfigStore>>,
    ) -> Result<Self, EnvRuntimeError> {
        let relative = grant
            .dir()
            .project_observed_path(&path)
            .ok_or(EnvRuntimeError::PermissionRequired)?;
        let files = Arc::new(
            ExactFileSystem::new(grant.clone(), &relative)
                .map_err(|error| EnvRuntimeError::Failed(error.to_string()))?,
        );
        let watcher = if grant.permissions().allows(Permission::WatchFiles) {
            Some(
                FileSystemWatcher::start_for_file(
                    grant.clone(),
                    Arc::clone(updates),
                    CONFIGURATION_ROUTE.into(),
                    relative,
                    authority.clone(),
                )
                .map_err(|error| EnvRuntimeError::Failed(error.to_string()))?,
            )
        } else {
            None
        };
        Ok(Self {
            path,
            ceiling: grant.permissions().clone(),
            grant,
            files,
            _watcher: watcher,
            authority,
        })
    }
}

impl Drop for ConfigurationFile {
    fn drop(&mut self) {
        self.grant.revoke();
    }
}

fn independent_grant(source: &Grant) -> Grant {
    Grant::for_environment(
        source.dir().clone(),
        source.source(),
        source.permissions().clone(),
    )
    .with_path_policy(source.path_policy().clone())
}

impl AppServer {
    pub(crate) fn snapshot_web_workspace(&self) -> Result<WebWorkspaceRollback, EnvRuntimeError> {
        let runtime = self
            .env_runtime
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut dirs: Vec<_> = runtime
            .dirs
            .iter()
            .filter(|(_, dir)| dir.grant.is_active())
            .map(|(id, dir)| (id.clone(), independent_grant(&dir.grant)))
            .collect();
        dirs.sort_by_key(|(_, grant)| {
            !runtime
                .selected_grant
                .as_ref()
                .is_some_and(|selected| selected.dir() == grant.dir())
        });
        drop(runtime);
        let configuration = self
            .web_configuration
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let configuration = configuration
            .as_ref()
            .filter(|file| file.grant.is_active())
            .map(|file| ConfigurationRollback {
                path: file.path.clone(),
                grant: independent_grant(&file.grant),
            });
        Ok(WebWorkspaceRollback {
            dirs,
            configuration,
        })
    }

    pub(crate) fn restore_web_workspace(
        &self,
        snapshot: &mut WebWorkspaceRollback,
    ) -> Result<(), EnvRuntimeError> {
        let dirs = snapshot
            .dirs
            .iter()
            .map(|(id, grant)| {
                self.refresh_web_rollback_grant(grant)
                    .map(|grant| (id.clone(), grant))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let configuration = snapshot
            .configuration
            .as_ref()
            .map(|file| {
                let grant = self.refresh_web_rollback_grant(&file.grant)?;
                if grant.authorize(Permission::ReadFiles).is_err() {
                    return Ok(None);
                }
                ConfigurationFile::open(
                    file.path.clone(),
                    grant,
                    &self.updates,
                    self.config.clone(),
                )
                .map(Some)
            })
            .transpose()?
            .flatten();
        self.activate_local_dirs(dirs)?;
        *self
            .web_configuration
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = configuration;
        Ok(())
    }

    fn refresh_web_rollback_grant(&self, previous: &Grant) -> Result<Grant, EnvRuntimeError> {
        previous
            .dir()
            .directory()
            .ensure_current()
            .map_err(|_| EnvRuntimeError::PermissionRequired)?;
        if previous.source() != GrantSource::ExplicitUser {
            return Ok(independent_grant(previous));
        }
        // A retained rollback proof cannot resurrect permissions revoked in user configuration
        // while the window was saving state. Reissue through its original authority and narrow.
        let current =
            self.authorize_local_dir_root(previous.dir().canonical_path().to_path_buf(), None)?;
        if current.dir() != previous.dir() {
            return Err(EnvRuntimeError::PermissionRequired);
        }
        let permissions = Permissions::new(
            previous
                .permissions()
                .entries()
                .filter(|permission| current.permissions().allows(*permission)),
        );
        Ok(
            Grant::for_environment(current.dir().clone(), previous.source(), permissions)
                .with_path_policy(previous.path_policy().intersect(current.path_policy())),
        )
    }

    /// The authenticated control owner has approved these roots. Browser JSON-RPC never gains
    /// directoryGrantsHost authority. Preparing proofs does not publish a partial directory set.
    pub(crate) fn bind_web_workspace(
        &self,
        configuration: Option<String>,
        folders: Vec<(Dir, String)>,
    ) -> Result<WebWorkspaceState, EnvRuntimeError> {
        let mut grants = Vec::new();
        let mut projected = Vec::new();
        for (dir, name) in folders {
            dir.directory()
                .ensure_current()
                .map_err(|_| EnvRuntimeError::PermissionRequired)?;
            let retained = self
                .env_runtime
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .dirs
                .values()
                .find(|entry| entry.grant.is_active() && entry.grant.dir() == &dir)
                .map(|entry| entry.grant.clone());
            let grant = match retained {
                Some(grant) => grant,
                None => self.authorize_local_dir_root(dir.canonical_path().to_path_buf(), None)?,
            };
            if grant.dir() != &dir || !grant.is_active() {
                return Err(EnvRuntimeError::PermissionRequired);
            }
            let id = grant.dir().id().to_string();
            if projected
                .iter()
                .any(|folder: &WebWorkspaceFolder| folder.id == id)
            {
                continue;
            }
            projected.push(WebWorkspaceFolder {
                id: id.clone(),
                path: grant.dir().canonical_path().to_string_lossy().into_owned(),
                name: (!name.is_empty()).then_some(name),
            });
            grants.push((id, grant));
        }
        let configuration_path = configuration
            .as_ref()
            .map(|resource| {
                let url = url::Url::parse(resource)
                    .map_err(|error| EnvRuntimeError::Failed(error.to_string()))?;
                if url.query().is_some()
                    || url.fragment().is_some()
                    || !url.username().is_empty()
                    || url.password().is_some()
                {
                    return Err(EnvRuntimeError::PermissionRequired);
                }
                match url.scheme() {
                    "vscode-userdata" => Ok(None),
                    "file" => url
                        .to_file_path()
                        .map(Some)
                        .map_err(|_| EnvRuntimeError::PermissionRequired),
                    _ => Err(EnvRuntimeError::PermissionRequired),
                }
            })
            .transpose()?
            .flatten();
        let retained_configuration = self
            .web_configuration
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let same_configuration = retained_configuration.as_ref().is_some_and(|file| {
            configuration_path.as_ref() == Some(&file.path) && file.grant.is_active()
        });
        let next_configuration = if same_configuration {
            None
        } else {
            configuration_path
                .as_ref()
                .map(|path| {
                    // Establish a fresh lease from an already authorized directory. Removing that
                    // workspace root can revoke its broad proof without revoking this exact file.
                    let runtime = self
                        .env_runtime
                        .read()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    let source = grants
                        .iter()
                        .map(|(_, grant)| grant)
                        .chain(runtime.dirs.values().map(|directory| &directory.grant))
                        .chain(runtime.selected_grant.iter())
                        .find(|grant| {
                            grant.is_active() && grant.dir().project_observed_path(path).is_some()
                        })
                        .ok_or(EnvRuntimeError::PermissionRequired)?;
                    let relative = source
                        .dir()
                        .project_observed_path(path)
                        .ok_or(EnvRuntimeError::PermissionRequired)?;
                    let scope = PathAccessPolicy::for_exact_file(&relative)
                        .map_err(EnvRuntimeError::Failed)?;
                    let grant = Grant::for_environment(
                        source.dir().clone(),
                        source.source(),
                        source.permissions().clone(),
                    )
                    .with_path_policy(source.path_policy().intersect(&scope));
                    grant
                        .authorize(Permission::ReadFiles)
                        .map_err(|_| EnvRuntimeError::PermissionRequired)?;
                    ConfigurationFile::open(path.clone(), grant, &self.updates, self.config.clone())
                })
                .transpose()?
        };
        drop(retained_configuration);
        self.activate_local_dirs(grants)?;
        if !same_configuration {
            *self
                .web_configuration
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = next_configuration;
        }
        let id = configuration.clone().unwrap_or_else(|| {
            projected
                .first()
                .map(|folder| folder.id.clone())
                .unwrap_or_else(|| "web-empty-workspace".into())
        });
        Ok(WebWorkspaceState {
            id,
            configuration,
            folders: projected,
        })
    }

    pub(crate) fn close_web_workspace(&self) {
        let runtime = self
            .env_runtime
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for grant in runtime
            .selected_grant
            .iter()
            .chain(runtime.dirs.values().map(|dir| &dir.grant))
        {
            grant.revoke();
        }
        drop(runtime);
        self.web_configuration
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
    }

    pub(crate) fn web_workspace_authorizes_directory(&self, dir: &Dir) -> bool {
        let runtime = self
            .env_runtime
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        runtime
            .dirs
            .values()
            .any(|entry| entry.grant.dir() == dir && entry.grant.is_active())
    }

    pub(super) fn web_configuration_route(&self, path: &Path) -> Option<FsResolvePathResult> {
        let configuration = self
            .web_configuration
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let file = configuration.as_ref()?;
        if path != file.path || !file.grant.is_active() {
            return None;
        }
        Some(FsResolvePathResult {
            root: [
                file.grant.dir().requested_path(),
                file.grant.dir().canonical_path(),
            ]
            .into_iter()
            .find(|root| path.starts_with(root))?
            .to_path_buf(),
            target: FsDirectoryTarget::Environment {
                dir_id: CONFIGURATION_ROUTE.into(),
            },
        })
    }

    pub(super) fn web_configuration_file_system(
        &self,
        id: Option<&str>,
    ) -> Result<Option<Arc<dyn FileSystem>>, super::RpcError> {
        if id != Some(CONFIGURATION_ROUTE) {
            return Ok(None);
        }
        // A real file request cannot wait for the profile watcher's next turn after a different
        // window changes user authority. Reconcile this detached proof at its owning boundary.
        if let Some(config) = &self.config {
            let snapshot = config.read_snapshot().map_err(|_| {
                super::RpcError::new(
                    -32030,
                    ash_app_server_protocol::protocol::error::AppServerErrorName::ConfigUnavailable,
                )
            })?;
            ConfigurationFile::reconcile(&self.web_configuration, &snapshot.values, &self.updates).map_err(|_| super::RpcError::new(-32043, ash_app_server_protocol::protocol::error::AppServerErrorName::PermissionRequired))?;
        }
        Ok(self
            .web_configuration
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .map(|file| Arc::clone(&file.files)))
    }
}
