// Adapted from OpenAI Codex windows-sandbox-rs/src/audit.rs and acl.rs.
// Licensed under Apache-2.0; see LICENSE-APACHE and NOTICE.
//! Bounded writable-path audit for the explicitly selected Windows account model.

use super::Execution;
use super::win;
use super::win::Result;
use std::collections::BTreeSet;
use std::os::windows::fs::MetadataExt;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;
use std::time::Instant;
use windows_sys::Win32::Security::Authorization::GetSecurityInfo;
use windows_sys::Win32::Security::Authorization::SE_FILE_OBJECT;
use windows_sys::Win32::Security::*;
use windows_sys::Win32::Storage::FileSystem::*;

const MAX_ITEMS_PER_DIRECTORY: usize = 1000;
const MAX_CHECKED: usize = 50_000;
const TIME_LIMIT: Duration = Duration::from_secs(2);
const MUTATION: u32 = FILE_WRITE_DATA
    | FILE_APPEND_DATA
    | FILE_WRITE_EA
    | FILE_WRITE_ATTRIBUTES
    | FILE_DELETE_CHILD
    | DELETE
    | WRITE_DAC
    | WRITE_OWNER;

/// Conservative allow-ACE inspection, not a complete token access check.
pub(super) fn world_writable(path: &Path) -> Result<bool> {
    mask_allowed(path, &["S-1-1-0"], MUTATION)
}

pub(super) fn directory_traversable(path: &Path) -> Result<bool> {
    mask_allowed(
        path,
        &["S-1-1-0", "S-1-5-11", "S-1-5-32-545"],
        FILE_READ_ATTRIBUTES,
    )
}

fn mask_allowed(path: &Path, principals: &[&str], desired: u32) -> Result<bool> {
    let handle = win::Handle::new(
        unsafe {
            CreateFileW(
                win::wide(path).as_ptr(),
                READ_CONTROL,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                std::ptr::null_mut(),
            )
        },
        "open audit path",
    )?;
    let mut acl = std::ptr::null_mut();
    let mut descriptor = std::ptr::null_mut();
    let status = unsafe {
        GetSecurityInfo(
            handle.0,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut acl,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    let _descriptor = win::Local(descriptor);
    if status != 0 {
        return Err(format!("read audit ACL: Windows error {status}"));
    }
    if acl.is_null() {
        return Ok(true);
    }
    if unsafe { IsValidAcl(acl) } == 0 {
        return Err("invalid audit ACL".into());
    }
    let principals = principals
        .iter()
        .map(|sid| win::sid(sid))
        .collect::<Result<Vec<_>>>()?;
    let mapping = GENERIC_MAPPING {
        GenericRead: FILE_GENERIC_READ,
        GenericWrite: FILE_GENERIC_WRITE,
        GenericExecute: FILE_GENERIC_EXECUTE,
        GenericAll: FILE_ALL_ACCESS,
    };
    for index in 0..unsafe { (*acl).AceCount } {
        let mut entry = std::ptr::null_mut();
        if unsafe { GetAce(acl, u32::from(index), &mut entry) } == 0 {
            return Err(win::error("GetAce(audit)"));
        }
        let header = unsafe { &*entry.cast::<ACE_HEADER>() };
        if header.AceType != 0 || header.AceFlags & 0x08 != 0 {
            continue;
        }
        let ace = unsafe { &*entry.cast::<ACCESS_ALLOWED_ACE>() };
        if !principals.iter().any(
            |sid| unsafe { EqualSid((&ace.SidStart as *const u32).cast_mut().cast(), sid.0) } != 0,
        ) {
            continue;
        }
        let mut mask = ace.Mask;
        unsafe {
            MapGenericMask(&mut mask, &mapping);
        }
        if mask & desired != 0 {
            return Ok(true);
        }
    }
    Ok(false)
}

struct Report {
    flagged: BTreeSet<PathBuf>,
    checked: usize,
    unreadable: usize,
    truncated: bool,
}

fn scan(roots: impl IntoIterator<Item = PathBuf>) -> Report {
    let start = Instant::now();
    let mut report = Report {
        flagged: BTreeSet::new(),
        checked: 0,
        unreadable: 0,
        truncated: false,
    };
    let mut seen = BTreeSet::new();
    for root in roots {
        let entries = std::fs::read_dir(&root);
        let mut paths = vec![root];
        match entries {
            Ok(entries) => {
                for (index, entry) in entries.enumerate() {
                    if index >= MAX_ITEMS_PER_DIRECTORY {
                        report.truncated = true;
                        break;
                    }
                    match entry {
                        Ok(entry) => paths.push(entry.path()),
                        Err(_) => report.unreadable += 1,
                    }
                }
            }
            Err(_) => report.unreadable += 1,
        }
        for path in paths {
            if report.checked >= MAX_CHECKED || start.elapsed() >= TIME_LIMIT {
                report.truncated = true;
                return report;
            }
            let Ok(metadata) = std::fs::symlink_metadata(&path) else {
                report.unreadable += 1;
                continue;
            };
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                continue;
            }
            let Ok(path) = std::fs::canonicalize(path) else {
                report.unreadable += 1;
                continue;
            };
            if !seen.insert(path.clone()) {
                continue;
            }
            report.checked += 1;
            match world_writable(&path) {
                Ok(true) => {
                    report.flagged.insert(path);
                }
                Ok(false) => {}
                Err(_) => report.unreadable += 1,
            }
        }
    }
    report
}

fn check_findings(request: &Execution, paths: &BTreeSet<PathBuf>) -> Result<()> {
    let authority = request
        .host_acl_scope
        .as_ref()
        .ok_or("missing scoped ACL authorization")?;
    let outside = paths
        .iter()
        .filter(|path| authority.check(path).is_err())
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>();
    if !outside.is_empty() {
        return Err(format!(
            "Windows account audit found Everyone-writable paths outside the authorized ACL scope; explicit host remediation is required before execution:\n{}",
            outside.join("\n")
        ));
    }
    Ok(())
}

pub(super) fn check(request: &Execution) -> Result<()> {
    let mut roots = vec![PathBuf::from(&request.working_directory)];
    roots.extend(request.files.readonly_paths.iter().map(PathBuf::from));
    roots.extend(request.files.readwrite_paths.iter().map(PathBuf::from));
    for name in ["TEMP", "TMP", "USERPROFILE", "PUBLIC"] {
        if let Some(value) = std::env::var_os(name) {
            roots.push(value.into());
        }
    }
    if let Some(path) = request.env.iter().find_map(|entry| {
        entry
            .split_once('=')
            .filter(|(name, _)| name.eq_ignore_ascii_case("PATH"))
            .map(|(_, value)| value)
    }) {
        roots.extend(std::env::split_paths(path));
    }
    if let Some(system) = std::env::var_os("SystemRoot") {
        let system = PathBuf::from(system);
        if let Some(root) = system.ancestors().last() {
            roots.push(root.to_owned());
        }
        roots.push(system);
    }
    let report = scan(roots);
    // Report bounded coverage honestly; the caller has explicitly accepted the
    // account model. No observation here establishes Strict isolation.
    if report.truncated || report.unreadable != 0 {
        eprintln!(
            "Windows account ACL audit: {} checked, {} unreadable, bounded scan truncated={}",
            report.checked, report.unreadable, report.truncated
        );
    }
    check_findings(request, &report.flagged)
}

#[cfg(test)]
#[path = "audit_tests.rs"]
mod tests;
