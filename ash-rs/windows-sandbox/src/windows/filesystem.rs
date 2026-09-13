// Licensed under the MIT License.
//! Prepare exact path grants while retaining object handles until teardown.

use super::Execution;
use super::win;
use super::win::Handle;
use super::win::Result;
use std::collections::BTreeSet;
use std::os::windows::fs::MetadataExt;
use std::path::Path;
use std::path::PathBuf;
use windows_sys::Win32::Storage::FileSystem::CreateFileW;
use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;
use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
use windows_sys::Win32::Storage::FileSystem::FILE_READ_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_WRITE;
use windows_sys::Win32::Storage::FileSystem::OPEN_EXISTING;
use wxc_common::filesystem_dacl::DaclManager;

pub(super) struct Filesystem {
    manager: DaclManager,
    _pins: Vec<Handle>,
}

fn canonical(path: impl AsRef<Path>) -> Result<PathBuf> {
    std::fs::canonicalize(path).map_err(|error| error.to_string())
}

pub(super) fn pin(path: &Path) -> Result<Handle> {
    Handle::new(
        unsafe {
            CreateFileW(
                win::wide(path).as_ptr(),
                FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                std::ptr::null_mut(),
            )
        },
        "CreateFileW(pin filesystem object)",
    )
}

fn hidden_objects(root: &Path, grants: &[PathBuf], objects: &mut BTreeSet<PathBuf>) -> Result<()> {
    // A grant is an exception only when it is strictly below this denied root.
    // A denied file inside a granted directory must still receive a deny ACE.
    let reopened = grants
        .iter()
        .filter(|grant| grant.as_path() != root && grant.starts_with(root))
        .collect::<Vec<_>>();
    collect_hidden_objects(root, &reopened, objects)
}

fn collect_hidden_objects(
    root: &Path,
    reopened: &[&PathBuf],
    objects: &mut BTreeSet<PathBuf>,
) -> Result<()> {
    if reopened.iter().any(|grant| root.starts_with(grant)) {
        return Ok(());
    }
    let metadata = std::fs::symlink_metadata(root).map_err(|error| error.to_string())?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(format!(
            "the user backend cannot enforce a redirected hidden object: '{}'",
            root.display()
        ));
    }
    objects.insert(root.to_owned());
    if objects.len() > 50_000 {
        return Err("hidden filesystem policy exceeds 50000 objects".into());
    }
    if metadata.is_dir() {
        for entry in std::fs::read_dir(root).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            collect_hidden_objects(&entry.path(), reopened, objects)?;
        }
    }
    Ok(())
}

impl Filesystem {
    pub(super) fn prepare(
        request: &Execution,
        account: &str,
        capability: &str,
        journal: &Path,
    ) -> Result<Self> {
        // Audit before any ACL mutation. Findings outside the granted ACL scope
        // require a separate explicit host change, never an implicit elevation.
        super::audit::check(request)?;
        validate(&request.files)?;
        let authority = request
            .host_acl_scope
            .as_ref()
            .ok_or("the user backend requires independently authorized host ACL roots")?;
        for path in request
            .files
            .readwrite_paths
            .iter()
            .chain(&request.files.readonly_paths)
        {
            let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(format!(
                    "a filesystem grant was replaced by a reparse point: '{path}'"
                ));
            }
        }
        let writable = request
            .files
            .readwrite_paths
            .iter()
            .map(canonical)
            .collect::<Result<Vec<_>>>()?;
        let readonly = request
            .files
            .readonly_paths
            .iter()
            .map(canonical)
            .collect::<Result<Vec<_>>>()?;
        let grants = writable
            .iter()
            .chain(&readonly)
            .cloned()
            .collect::<Vec<_>>();
        let mut traversal = BTreeSet::new();
        for grant in &grants {
            for ancestor in grant.ancestors().skip(1) {
                if !super::audit::directory_traversable(ancestor)? {
                    if authority.check(ancestor).is_err()
                        && request.acl_changes
                            != ash_sandboxing::HostAclChanges::ScopedWithTraversal
                    {
                        return Err(format!(
                            "directory traversal needs separate ACL authorization: '{}'",
                            ancestor.display()
                        ));
                    }
                    traversal.insert(ancestor.to_owned());
                }
            }
        }
        let mut denied = BTreeSet::new();
        for root in &request.files.denied_paths {
            hidden_objects(&canonical(root)?, &grants, &mut denied)?;
        }
        let mut paths = denied.clone();
        paths.extend(grants.iter().cloned());
        paths.extend(traversal.iter().cloned());
        let mut pins = Vec::new();
        for path in &paths {
            if !traversal.contains(path) {
                authority.check(path).map_err(|error| error.to_string())?;
            }
            let handle = pin(path)?;
            if canonical(path)? != *path {
                return Err("filesystem path changed during preparation".into());
            }
            pins.push(handle);
        }
        // Check delegation before any ACL change. An elevated setup process is
        // never used to reinterpret a caller's filesystem grants.
        wxc_common::filesystem_access::check_delegation(&request.files)
            .map_err(|error| error.to_string())?;
        let report = wxc_common::filesystem_dacl::recover_orphaned_state_in(journal)
            .map_err(|error| error.to_string())?;
        if !report.errors.is_empty() {
            return Err("orphaned Windows ACL state must be recovered before execution".into());
        }
        let mut manager = DaclManager::in_directory(journal).map_err(|error| error.to_string())?;
        let (ancestors, hidden): (Vec<_>, Vec<_>) = denied
            .into_iter()
            .partition(|path| grants.iter().any(|grant| grant.starts_with(path)));
        manager
            .add_deny_aces(account, &hidden)
            .map_err(|error| error.to_string())?;
        for ancestor in ancestors {
            manager
                .deny_directory_contents(account, &ancestor)
                .map_err(|error| error.to_string())?;
        }
        for ancestor in traversal {
            manager
                .grant_directory_traversal(account, &ancestor)
                .map_err(|error| error.to_string())?;
        }
        manager
            .grant_appcontainer_access(account, &writable, &readonly)
            .map_err(|error| error.to_string())?;
        manager
            .grant_appcontainer_access(capability, &writable, &[])
            .map_err(|error| error.to_string())?;
        manager
            .deny_write_access(capability, &readonly)
            .map_err(|error| error.to_string())?;
        Ok(Self {
            manager,
            _pins: pins,
        })
    }

    pub(super) fn restore(&mut self) -> Result<()> {
        self.manager
            .restore_strict()
            .map_err(|error| error.to_string())
    }
}

pub(super) fn validate(policy: &wxc_common::models::ContainerPolicy) -> Result<()> {
    use windows_sys::Win32::Storage::FileSystem::BY_HANDLE_FILE_INFORMATION;
    use windows_sys::Win32::Storage::FileSystem::GetFileInformationByHandle;
    let writable = policy
        .readwrite_paths
        .iter()
        .map(canonical)
        .collect::<Result<Vec<_>>>()?;
    let readonly = policy
        .readonly_paths
        .iter()
        .map(canonical)
        .collect::<Result<Vec<_>>>()?;
    let mut pending = writable
        .iter()
        .chain(&readonly)
        .cloned()
        .collect::<Vec<_>>();
    let mut seen = BTreeSet::new();
    while let Some(path) = pending.pop() {
        let metadata = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        let target = canonical(&path)?;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            let written = writable.iter().any(|root| path.starts_with(root))
                && !readonly.iter().any(|root| path.starts_with(root));
            let target_written = writable.iter().any(|root| target.starts_with(root))
                && !readonly.iter().any(|root| target.starts_with(root));
            if !writable
                .iter()
                .chain(&readonly)
                .any(|root| target.starts_with(root))
                || written != target_written
            {
                return Err(format!(
                    "a filesystem link crosses its authorized access boundary: '{}'",
                    path.display()
                ));
            }
        }
        if !seen.insert(target.clone()) {
            continue;
        }
        if seen.len() > 100_000 {
            return Err("filesystem ACL validation exceeds 100000 objects".into());
        }
        let metadata = std::fs::metadata(&target).map_err(|error| error.to_string())?;
        if metadata.is_dir() {
            for entry in std::fs::read_dir(&target).map_err(|error| error.to_string())? {
                pending.push(entry.map_err(|error| error.to_string())?.path());
            }
        } else {
            let handle = pin(&target)?;
            let mut identity = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
            if unsafe { GetFileInformationByHandle(handle.0, &mut identity) } == 0 {
                return Err(win::error("GetFileInformationByHandle(ACL target)"));
            }
            if identity.nNumberOfLinks > 1 {
                return Err(format!(
                    "filesystem ACL changes cannot authorize a multiply linked file: '{}'",
                    target.display()
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "filesystem_tests.rs"]
mod tests;
