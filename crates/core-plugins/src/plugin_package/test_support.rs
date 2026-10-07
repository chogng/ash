use std::io;

pub(super) fn link_capability_available(result: io::Result<()>, capability: &str) -> bool {
    match result {
        Ok(()) => true,
        Err(error) if link_capability_is_unavailable(&error) => {
            eprintln!("skipping {capability} assertion on this filesystem: {error}");
            false
        }
        Err(error) => panic!("failed to create {capability} fixture: {error}"),
    }
}

fn link_capability_is_unavailable(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::PermissionDenied | io::ErrorKind::Unsupported
    ) || platform_link_capability_is_unavailable(error)
}

#[cfg(windows)]
fn platform_link_capability_is_unavailable(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(1 | 50 | 1314))
}

#[cfg(not(windows))]
fn platform_link_capability_is_unavailable(_: &io::Error) -> bool {
    false
}
