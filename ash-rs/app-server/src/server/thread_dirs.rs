use crate::dir_grants::DirGrants;
use ash_config::ConfigStore;
use ash_file_access::{Dir, DirId};
use ash_hooks::DeclarativeHookRuntime;
use ash_protocol::ThreadId;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use worktree::{ManagedDirBinding, WorktreeManager, WorktreeSettings};

/// App Server composition of Thread directory bindings and their local execution services.
pub(super) struct ThreadDirs {
    pub(super) root: PathBuf,
    pub(super) id: DirId,
    pub(super) worktrees: WorktreeManager,
    pub(super) runtime: tokio::runtime::Runtime,
    pub(super) bindings: RwLock<BTreeMap<ThreadId, ManagedDirBinding>>,
    pub(super) file_access: Arc<DirGrants>,
    pub(super) hooks: Arc<DeclarativeHookRuntime>,
}

impl ThreadDirs {
    pub(super) fn open(
        profile_root: &Path,
        dir_root: &Path,
        config: &ConfigStore,
        file_access: Arc<DirGrants>,
        hooks: Arc<DeclarativeHookRuntime>,
    ) -> Result<Arc<Self>, String> {
        let dir = Dir::open_local(dir_root).map_err(|error| error.to_string())?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .worker_threads(1)
            .thread_name("thread-worktrees")
            .build()
            .map_err(|error| error.to_string())?;
        let desktop = config
            .read_snapshot()
            .map_err(|error| format!("cannot read managed worktree settings: {error}"))?
            .values
            .desktop;
        let settings = WorktreeSettings::from_desktop_config(profile_root, &desktop)
            .map_err(|error| format!("cannot resolve managed worktree settings: {error}"))?;
        let worktrees = WorktreeManager::new(settings);
        let recovered = runtime
            .block_on(worktrees.recover_threads(dir.canonical_path(), dir.id().as_str()))
            .map_err(|error| format!("cannot recover Thread worktrees: {error}"))?;
        let bindings = recovered
            .into_iter()
            .map(|(thread_id, binding)| {
                ThreadId::new(thread_id)
                    .map(|thread_id| (thread_id, binding))
                    .map_err(|error| error.to_string())
            })
            .collect::<Result<BTreeMap<_, _>, _>>()?;
        for (thread_id, binding) in &bindings {
            let root = Dir::open_local(binding.dir()).map_err(|error| error.to_string())?;
            hooks
                .bind_thread_dir(thread_id.clone(), root.clone())
                .map_err(|error| error.to_string())?;
            file_access.bind_thread_dir(thread_id.clone(), root);
        }
        Ok(Arc::new(Self {
            root: dir.canonical_path().to_path_buf(),
            id: dir.id(),
            worktrees,
            runtime,
            bindings: RwLock::new(bindings),
            file_access,
            hooks,
        }))
    }

    pub(super) fn binding(&self, thread_id: &ThreadId) -> Option<ManagedDirBinding> {
        self.bindings
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(thread_id)
            .cloned()
    }

    pub(super) fn bind_services(
        &self,
        thread_id: &ThreadId,
        binding: &ManagedDirBinding,
    ) -> Result<(), String> {
        let root = Dir::open_local(binding.dir()).map_err(|error| error.to_string())?;
        self.hooks
            .bind_thread_dir(thread_id.clone(), root.clone())
            .map_err(|error| error.to_string())?;
        self.file_access.bind_thread_dir(thread_id.clone(), root);
        Ok(())
    }
}
