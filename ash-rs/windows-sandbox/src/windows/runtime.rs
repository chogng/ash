// Licensed under the MIT License.
//! Explicit, journaled provisioning and exclusive execution-identity leases.

use super::account;
use super::account::Account;
use super::account::NetworkMode;
use super::network::Rules;
use super::win;
use super::win::Result;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use std::fs::File;
use std::fs::OpenOptions;
use std::os::windows::fs::OpenOptionsExt;
use std::path::Path;
use std::path::PathBuf;
use windows_sys::Win32::Security::DACL_SECURITY_INFORMATION;
use windows_sys::Win32::Security::PROTECTED_DACL_SECURITY_INFORMATION;
use windows_sys::Win32::Security::SetFileSecurityW;

const VERSION: u32 = 4;

#[derive(Clone, Copy, Deserialize, Serialize, Eq, PartialEq)]
enum Status {
    Preparing,
    Ready,
    Updating,
    Removing,
}

#[derive(Deserialize, Serialize)]
struct State {
    version: u32,
    owner: String,
    status: Status,
    runner_hash: String,
    // Retain both authorized images through Removing so an interrupted rename
    // cannot make its own replacement look like an unrelated executable.
    pending_runner_hash: Option<String>,
    accounts: Vec<Account>,
    rules: Option<Rules>,
}

impl State {
    fn save(&self, root: &Path) -> Result<()> {
        let mut json = serde_json::to_vec(self).map_err(|_| "could not encode runtime journal")?;
        let result = account::seal(&root.join("state.dpapi"), &mut json);
        for byte in &mut json {
            unsafe {
                std::ptr::write_volatile(byte, 0);
            }
        }
        result
    }
}

pub(super) struct Lease {
    pub(super) account: Account,
    pub(super) root: PathBuf,
    pub(super) runner: PathBuf,
    pub(super) runner_hash: String,
    _lock: File,
    _pins: Vec<win::Handle>,
}

pub(super) fn root() -> Result<PathBuf> {
    Ok(super::service::directory()?
        .join("runtimes")
        .join(win::current_user()?))
}

pub(super) fn hash(path: &Path) -> Result<String> {
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    Ok(format!("{:x}", sha2::Sha256::digest(bytes)))
}

fn read_state() -> Result<(PathBuf, State)> {
    let root = root()?;
    let _pins = win::pin_executable(&root.join("state.dpapi"))?;
    for path in [
        super::service::directory()?,
        root.clone(),
        root.join("state.dpapi"),
    ] {
        win::verify_service_path(&path)?;
    }
    let mut data = account::unseal(&root.join("state.dpapi"))
        .map_err(|_| "the Ash user runtime requires setup; use ash-windows-sandbox setup with explicit account and network authorization")?;
    let parsed =
        serde_json::from_slice::<State>(&data).map_err(|_| "invalid Ash user runtime state");
    for byte in &mut data {
        unsafe {
            std::ptr::write_volatile(byte, 0);
        }
    }
    let state = parsed?;
    if state.version != VERSION
        || state.owner != win::current_user()?
        || state.accounts.is_empty()
        || state.accounts.len() > 48
    {
        return Err("the runtime journal has an unexpected owner, version, or account set".into());
    }
    Ok((root, state))
}

fn checked_state() -> Result<(PathBuf, State, Vec<win::Handle>)> {
    let (root, state) = read_state()?;
    match state.status {
        Status::Ready => {}
        Status::Updating => {
            return Err(
                "runtime update is incomplete; approve a new update or removal plan".into(),
            );
        }
        Status::Preparing | Status::Removing => {
            return Err(
                "runtime provisioning or removal is incomplete; approve its removal plan".into(),
            );
        }
    }
    let runner = root.join("bin").join("ash-windows-sandbox.exe");
    let pins = win::pin_executable(&runner)?;
    if hash(&runner)? != state.runner_hash {
        return Err(
            "the Ash runtime executable differs from its journal; inspect its removal plan".into(),
        );
    }
    state
        .rules
        .as_ref()
        .ok_or("runtime network plan is missing")?
        .verify(&state.accounts)?;
    Ok((root, state, pins))
}

pub(super) fn available(mode: NetworkMode) -> Result<String> {
    let (_, state, _pins) = checked_state()?;
    if state.accounts.iter().any(|account| account.mode == mode) {
        Ok(state.runner_hash)
    } else {
        Err("the requested network mode was not provisioned".into())
    }
}

pub(super) fn lease(mode: NetworkMode) -> Result<Lease> {
    // Serialize lease acquisition with removal, including callers that already
    // passed an earlier availability check.
    let _setup_lock = OpenOptions::new()
        .read(true)
        .share_mode(windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ)
        .open(root()?.join("setup.lock"))
        .map_err(|error| format!("runtime provisioning or removal is in progress: {error}"))?;
    let (root, state, pins) = checked_state()?;
    for (index, account) in state.accounts.into_iter().enumerate() {
        if account.mode != mode {
            continue;
        }
        let lock = match OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(root.join(format!("lease-{index}")))
        {
            Ok(lock) => lock,
            Err(error) if error.raw_os_error() == Some(32) => continue,
            Err(error) => return Err(error.to_string()),
        };
        if account::lookup(&account.name)? != account.sid {
            return Err("a provisioned sandbox account has been replaced".into());
        }
        if root
            .join("runs")
            .join(&account.sid)
            .try_exists()
            .map_err(|error| error.to_string())?
        {
            return Err("a previous execution needs explicit installation recovery before this identity can be reused".into());
        }
        return Ok(Lease {
            account,
            runner: root.join("bin").join("ash-windows-sandbox.exe"),
            runner_hash: state.runner_hash.clone(),
            root,
            _lock: lock,
            _pins: pins,
        });
    }
    Err("all independently isolated execution identities are in use".into())
}

pub(super) fn setup_plan(slots: usize, runner: &Path) -> Result<serde_json::Value> {
    if slots == 0 || slots > 16 {
        return Err("slots must be between 1 and 16 per network mode".into());
    }
    Ok(serde_json::json!({
        "operation": "setup", "version": VERSION, "ownerSid": win::current_user()?,
        "runtimeDirectory": root()?,
        "runnerSha256": hash(runner)?,
        "accounts": { "namePrefix": "ash", "slotsPerNetworkMode": slots, "total": slots * 3 },
        "network": { "modes": ["denied", "managed", "allowed"], "persistentFilters": slots * 13, "managedEndpoint": "one exclusive IPv4 loopback TCP port per managed account" },
        "filesystemAclChanges": "new runtime directory and its contents only",
        "executionAclAuthority": "separate scoped authorization required for each command"
    }))
}

pub(super) fn removal_plan() -> Result<serde_json::Value> {
    let root = root()?;
    if !root
        .join("state.dpapi")
        .try_exists()
        .map_err(|error| error.to_string())?
    {
        return initial_removal_plan(&root);
    }
    let (root, state) = read_state()?;
    let runner = root.join("bin/ash-windows-sandbox.exe");
    let installed_hash = if runner.try_exists().map_err(|error| error.to_string())? {
        Some(hash(&runner)?)
    } else {
        None
    };
    let pending = root.join("bin/runner.pending");
    let pending_hash = if pending.try_exists().map_err(|error| error.to_string())? {
        Some(hash(&pending)?)
    } else {
        None
    };
    Ok(serde_json::json!({
        "operation": "remove", "version": VERSION, "ownerSid": state.owner,
        "runtimeDirectory": root, "runnerSha256": state.runner_hash,
        "installedRunnerSha256": installed_hash,
        "pendingRunnerSha256": pending_hash, "approvedUpdateSha256": state.pending_runner_hash,
        "accounts": state.accounts.iter().map(|account| serde_json::json!({ "name": account.name, "sid": account.sid, "ownershipTag": account.tag })).collect::<Vec<_>>(),
        "networkObjects": state.rules,
        "filesystemAclChanges": "restore this installation's recorded execution ACL changes before deleting its runtime"
    }))
}

pub(super) fn plan_digest(plan: &serde_json::Value) -> Result<String> {
    let bytes = serde_json::to_vec(plan).map_err(|error| error.to_string())?;
    Ok(format!("{:x}", sha2::Sha256::digest(bytes)))
}

pub(super) fn approved_plan(plan: serde_json::Value) -> Result<serde_json::Value> {
    Ok(serde_json::json!({ "sha256": plan_digest(&plan)?, "changes": plan }))
}

pub(super) fn setup(slots: usize, runner_source: &Path, approved: &str) -> Result<()> {
    let _source_pins = win::pin_executable(runner_source)?;
    if approved != plan_digest(&setup_plan(slots, runner_source)?)? {
        return Err("installation approval does not match this user, binary, location, and account/network plan".into());
    }
    require_administrator()?;
    let _management = management_lock()?;
    let root = root()?;
    let owner = win::current_user()?;
    if root.try_exists().map_err(|error| error.to_string())? {
        let (_, state) = read_state()?;
        if state.status != Status::Ready {
            return Err(
                "an incomplete setup journal exists; remove its recorded objects before setup"
                    .into(),
            );
        }
        let _setup_lock = setup_lock(&root)?;
        if state.runner_hash != hash(runner_source)? {
            return Err("approve an update plan to replace this installation's executable".into());
        }
        available(NetworkMode::Denied)?;
        return Ok(());
    }
    let mut accounts = Vec::new();
    let mut listeners = Vec::new();
    for mode in [
        NetworkMode::Denied,
        NetworkMode::Managed,
        NetworkMode::Allowed,
    ] {
        for _ in 0..slots {
            let port = if mode == NetworkMode::Managed {
                let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
                    .map_err(|error| error.to_string())?;
                let port = listener
                    .local_addr()
                    .map_err(|error| error.to_string())?
                    .port();
                listeners.push(listener);
                port
            } else {
                0
            };
            accounts.push(account::plan(mode, port)?);
        }
    }
    let mut state = State {
        version: VERSION,
        owner,
        status: Status::Preparing,
        runner_hash: hash(runner_source)?,
        pending_runner_hash: None,
        accounts,
        rules: None,
    };
    win::verify_service_path(&super::service::directory()?)?;
    win::create_service_directory(&root, &state.owner)?;
    let _setup_lock = setup_lock(&root)?;
    // Commit planned identities before copying the image or creating accounts.
    // Without state.dpapi only the initial lock/encrypted staging file can exist.
    state.save(&root)?;
    let bin = root.join("bin");
    win::create_service_directory(&bin, &state.owner)?;
    let runner = bin.join("ash-windows-sandbox.exe");
    win::copy_service_image(runner_source, &runner, &[state.owner.clone()])?;
    for index in 0..state.accounts.len() {
        account::create(&mut state.accounts[index])?;
        state.save(&root)?;
    }
    let mut sddl = format!(
        "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;GRGX;;;{})",
        state.owner
    );
    for account in &state.accounts {
        sddl.push_str(&format!("(A;OICI;GRGX;;;{})", account.sid));
    }
    let sd = win::descriptor(&sddl)?;
    // SetFileSecurityW does not update ACLs of existing children. The runner
    // was copied before the account identities existed, so stamp it explicitly.
    for path in [&bin, &runner] {
        if unsafe {
            SetFileSecurityW(
                win::wide(path).as_ptr(),
                DACL_SECURITY_INFORMATION
                    | PROTECTED_DACL_SECURITY_INFORMATION
                    | windows_sys::Win32::Security::OWNER_SECURITY_INFORMATION,
                sd.0,
            )
        } == 0
        {
            return Err(win::error("SetFileSecurityW(runtime binaries)"));
        }
    }
    // The service-side logon path can traverse this newly owned root without
    // changing the signed-in user's profile ACL. Account grants do not inherit
    // into credentials, leases, or future state journals.
    let mut root_acl = format!(
        "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;GRGX;;;{})",
        state.owner
    );
    for account in &state.accounts {
        root_acl.push_str(&format!("(A;;GRGX;;;{})", account.sid));
    }
    let root_sd = win::descriptor(&root_acl)?;
    if unsafe {
        SetFileSecurityW(
            win::wide(&root).as_ptr(),
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            root_sd.0,
        )
    } == 0
    {
        return Err(win::error("SetFileSecurityW(runtime traversal)"));
    }
    for index in 0..state.accounts.len() {
        let path = root.join(format!("lease-{index}"));
        File::create(&path).map_err(|error| error.to_string())?;
        let sd = win::descriptor(&format!(
            "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGW;;;{})",
            state.owner
        ))?;
        if unsafe {
            SetFileSecurityW(
                win::wide(&path).as_ptr(),
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                sd.0,
            )
        } == 0
        {
            return Err(win::error("SetFileSecurityW(account lease)"));
        }
    }
    for name in ["runs", "acl"] {
        win::create_private_directory(&root.join(name), &state.owner)?;
    }
    // Every WFP GUID is journaled before the atomic network transaction begins.
    state.rules = Some(Rules::plan(&state.accounts)?);
    state.save(&root)?;
    let rules = state.rules.as_ref().unwrap();
    rules.install(&state.accounts)?;
    rules.verify(&state.accounts)?;
    state.status = Status::Ready;
    state.save(&root)?;
    Ok(())
}

pub(super) fn update_plan(runner: &Path) -> Result<serde_json::Value> {
    let (root, state) = read_state()?;
    Ok(serde_json::json!({
        "operation": "update", "version": VERSION, "ownerSid": state.owner,
        "runtimeDirectory": root, "installedRunnerSha256": hash(&root.join("bin/ash-windows-sandbox.exe"))?,
        "runnerSha256": hash(runner)?, "recordedRunnerSha256": state.runner_hash,
        "accounts": state.accounts.iter().map(|account| account.sid.clone()).collect::<Vec<_>>(),
        "networkObjects": state.rules
    }))
}

pub(super) fn update(runner: &Path, approved: &str) -> Result<()> {
    let _source_pins = win::pin_executable(runner)?;
    require_administrator()?;
    let _management = management_lock()?;
    let (root, mut state) = read_state()?;
    let _setup = setup_lock(&root)?;
    let mut leases = Vec::new();
    for index in 0..state.accounts.len() {
        leases.push(
            OpenOptions::new()
                .read(true)
                .write(true)
                .share_mode(0)
                .open(root.join(format!("lease-{index}")))
                .map_err(|error| error.to_string())?,
        );
    }
    if approved != plan_digest(&update_plan(runner)?)? {
        return Err("update approval does not match the installed accounts and executable".into());
    }
    if !matches!(state.status, Status::Ready | Status::Updating) {
        return Err("an incomplete setup or removal must be removed before update".into());
    }
    state
        .rules
        .as_ref()
        .ok_or("runtime network plan is missing")?
        .verify(&state.accounts)?;
    ensure_idle_accounts(&root, &state.accounts)?;
    let target = root.join("bin/ash-windows-sandbox.exe");
    let pending = root.join("bin/runner.pending");
    // New leases remain blocked after interruption until another explicit update
    // approves the current journal and images. Execution never repairs an update.
    state.status = Status::Updating;
    state.pending_runner_hash = Some(hash(runner)?);
    state.save(&root)?;
    let mut readers = vec![state.owner.clone()];
    readers.extend(state.accounts.iter().map(|account| account.sid.clone()));
    win::copy_service_image(runner, &pending, &readers)?;
    if unsafe {
        windows_sys::Win32::Storage::FileSystem::MoveFileExW(
            win::wide(&pending).as_ptr(),
            win::wide(&target).as_ptr(),
            windows_sys::Win32::Storage::FileSystem::MOVEFILE_REPLACE_EXISTING
                | windows_sys::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(win::error("MoveFileExW(updated runner)"));
    }
    state.runner_hash = hash(&target)?;
    state.pending_runner_hash = None;
    state.status = Status::Ready;
    state.save(&root)
}

fn ensure_idle_accounts(root: &Path, accounts: &[Account]) -> Result<()> {
    for account in accounts {
        let journal = root.join("acl").join(&account.sid);
        // DaclManager removes restored records but retains its reusable directory.
        // An empty ACL journal is completed work; a run directory still belongs
        // to an execution whose resource teardown has not finished.
        let pending_acl = journal.try_exists().map_err(|error| error.to_string())?
            && std::fs::read_dir(&journal)
                .map_err(|error| error.to_string())?
                .next()
                .transpose()
                .map_err(|error| error.to_string())?
                .is_some();
        if root.join("runs").join(&account.sid).exists() || pending_acl {
            return Err("an incomplete execution must be recovered before update".into());
        }
    }
    Ok(())
}

pub(super) fn remove(approved: &str) -> Result<()> {
    if approved != plan_digest(&removal_plan()?)? {
        return Err("removal approval does not match the recorded installation objects".into());
    }
    require_administrator()?;
    let _management = management_lock()?;
    let root = root()?;
    if !root
        .join("state.dpapi")
        .try_exists()
        .map_err(|error| error.to_string())?
    {
        let _pins = win::pin_executable(&root)?;
        win::verify_service_path(&root)?;
        if approved != plan_digest(&initial_removal_plan(&root)?)? {
            return Err(
                "initialization cleanup approval no longer matches the recorded files".into(),
            );
        }
        remove_file(&root.join("state.pending"))?;
        remove_file(&root.join("setup.lock"))?;
        drop(_pins);
        return std::fs::remove_dir(root).map_err(|error| error.to_string());
    }
    let (root, mut state) = read_state()?;
    let setup_guard = setup_lock(&root)?;
    let mut locks = Vec::new();
    for index in 0..state.accounts.len() {
        let path = root.join(format!("lease-{index}"));
        match OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(path)
        {
            Ok(lock) => locks.push(lock),
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound
                    && state.status != Status::Ready => {}
            Err(_) => {
                return Err(
                    "cannot remove a runtime with active executions or unreadable leases".into(),
                );
            }
        }
    }
    if state.status == Status::Preparing && root.join("bin/ash-windows-sandbox.exe").exists() {
        // A failed image copy may leave protected partial bytes. Their digest is
        // part of the approved removal plan; no Ready execution accepted them.
        state.runner_hash = hash(&root.join("bin/ash-windows-sandbox.exe"))?;
    }
    state.status = Status::Removing;
    state.save(&root)?;
    for account in &state.accounts {
        super::job::Job::recover(&account.name)?;
    }
    for account in &state.accounts {
        let journal = root.join("acl").join(&account.sid);
        let recovery = mxc_sdk::mxc_common::filesystem_dacl::recover_orphaned_state_in(&journal)
            .map_err(|error| error.to_string())?;
        if !recovery.errors.is_empty() {
            return Err("ACL recovery is incomplete; keep the runtime journal for recovery".into());
        }
        remove_empty_directory(&journal)?;
    }
    for account in &state.accounts {
        let path = root.join("runs").join(&account.sid);
        if path.try_exists().map_err(|error| error.to_string())? {
            let canonical = std::fs::canonicalize(&path).map_err(|error| error.to_string())?;
            let runs =
                std::fs::canonicalize(root.join("runs")).map_err(|error| error.to_string())?;
            if canonical.parent() != Some(runs.as_path())
                || canonical.file_name() != Some(std::ffi::OsStr::new(&account.sid))
            {
                return Err("execution recovery directory was redirected".into());
            }
            std::fs::remove_dir_all(&path).map_err(|error| error.to_string())?;
        }
    }
    for account in &state.accounts {
        account::remove(account)?;
    }
    if let Some(rules) = &state.rules {
        rules.remove()?;
    }
    // No new execution can acquire a lease after the Removing state is saved.
    drop(locks);
    let images = match &state.pending_runner_hash {
        Some(next) => RunnerImages::Updating {
            installed: &state.runner_hash,
            next,
        },
        None => RunnerImages::Installed(&state.runner_hash),
    };
    clean_files(&root, images, state.accounts.len())?;
    drop(setup_guard);
    remove_file(&root.join("setup.lock"))?;
    remove_file(&root.join("state.dpapi"))?;
    std::fs::remove_dir(&root)
        .map_err(|error| format!("runtime directory remains after cleanup: {error}"))?;
    if root.try_exists().map_err(|error| error.to_string())? {
        return Err("runtime directory still exists after cleanup".into());
    }
    Ok(())
}

fn remove_file(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("could not remove '{}': {error}", path.display())),
    }
}

fn initial_removal_plan(root: &Path) -> Result<serde_json::Value> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        let name = name
            .to_str()
            .ok_or("an uncommitted runtime has an invalid filename")?;
        if !matches!(name, "setup.lock" | "state.pending")
            || !entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_file()
        {
            return Err(
                "an uncommitted runtime contains unexpected data; preserve it for inspection"
                    .into(),
            );
        }
        files.push((name.to_owned(), hash(&entry.path())?));
    }
    files.sort();
    let files = files
        .into_iter()
        .map(|(name, digest)| serde_json::json!({"name": name, "sha256": digest}))
        .collect::<Vec<_>>();
    Ok(
        serde_json::json!({"operation": "remove-initialization", "version": VERSION,
        "ownerSid": win::current_user()?, "runtimeDirectory": root, "files": files,
        "accounts": [], "networkObjects": null}),
    )
}

fn remove_empty_directory(path: &Path) -> Result<()> {
    match std::fs::remove_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "directory '{}' needs recovery or inspection: {error}",
            path.display()
        )),
    }
}

enum RunnerImages<'a> {
    Installed(&'a str),
    Updating { installed: &'a str, next: &'a str },
}

impl RunnerImages<'_> {
    fn contains(&self, digest: &str) -> bool {
        match self {
            Self::Installed(installed) => digest == *installed,
            Self::Updating { installed, next } => digest == *installed || digest == *next,
        }
    }
}

fn clean_files(root: &Path, images: RunnerImages<'_>, accounts: usize) -> Result<()> {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
    // Only remove the recorded layout. Never recursively erase unknown data or
    // follow a junction, and retain the recovery journal on any mismatch.
    for entry in std::fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            return Err("unexpected runtime entry".into());
        };
        let known = matches!(
            name,
            "state.dpapi" | "state.pending" | "setup.lock" | "bin" | "runs" | "acl"
        ) || (0..accounts).any(|index| name == format!("lease-{index}"));
        if !known
            || std::fs::symlink_metadata(entry.path())
                .map_err(|error| error.to_string())?
                .file_attributes()
                & FILE_ATTRIBUTE_REPARSE_POINT
                != 0
        {
            return Err(format!(
                "unexpected or redirected runtime entry: '{}'",
                entry.path().display()
            ));
        }
    }
    remove_empty_directory(&root.join("runs"))?;
    remove_empty_directory(&root.join("acl"))?;
    let runner = root.join("bin/ash-windows-sandbox.exe");
    if runner.try_exists().map_err(|error| error.to_string())? {
        if std::fs::symlink_metadata(&runner)
            .map_err(|error| error.to_string())?
            .file_attributes()
            & FILE_ATTRIBUTE_REPARSE_POINT
            != 0
            || !images.contains(&hash(&runner)?)
        {
            return Err("the runtime executable changed; preserve it and the recovery journal for inspection".into());
        }
        remove_file(&runner)?;
    }
    let pending = root.join("bin/runner.pending");
    if pending.try_exists().map_err(|error| error.to_string())? {
        if !matches!(images, RunnerImages::Updating { .. }) {
            return Err("an unrecorded staged image must be preserved for inspection".into());
        }
        let pinned = win::pin_executable(&pending)?;
        win::verify_service_path(&pending)?;
        drop(pinned);
        remove_file(&pending)?;
    }
    remove_empty_directory(&root.join("bin"))?;
    for index in 0..accounts {
        remove_file(&root.join(format!("lease-{index}")))?;
    }
    remove_file(&root.join("state.pending"))?;
    Ok(())
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;

fn setup_lock(root: &Path) -> Result<File> {
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .share_mode(0)
        .open(root.join("setup.lock"))
        .map_err(|error| error.to_string())
}

fn management_lock() -> Result<File> {
    // SCM replacement/removal takes this same file exclusively. A service may
    // not retire its image while it is provisioning another user's accounts.
    OpenOptions::new()
        .read(true)
        .share_mode(windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ)
        .open(super::service::directory()?.join("install.lock"))
        .map_err(|error| error.to_string())
}

fn require_administrator() -> Result<()> {
    use windows_sys::Win32::Security::CheckTokenMembership;
    let administrators = win::sid("S-1-5-32-544")?;
    let mut member = 0;
    if unsafe { CheckTokenMembership(std::ptr::null_mut(), administrators.0, &mut member) } == 0
        || member == 0
    {
        Err("runtime provisioning requires explicit administrator approval; normal command execution does not".into())
    } else {
        Ok(())
    }
}
