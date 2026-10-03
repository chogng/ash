use crate::DirectoryEntry;
use crate::ExistingTargetBehavior;
use crate::FileContent;
use crate::FileDeleteMode;
use crate::FileMetadata;
use crate::FileMutation;
use crate::FileMutationError;
use crate::FileSystem;
use crate::FileSystemError;
use crate::FileType;
use crate::FileWriteCondition;
use crate::MissingTargetBehavior;
use crate::SystemFileTransferOperation;
use crate::file_revision;
use ash_file_access::Authorization;
use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::Permission;
use ash_file_identity::FileInformation;
use cap_std::fs::Dir as Directory;
use cap_std::fs::OpenOptions;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Filesystem bound to an explicitly granted subject and directory.
/// Every entry obtains and validates the exact action authorization before performing I/O.
pub struct LocalFileSystem {
    files: ScopedFiles,
    authority: Authority,
}

enum Authority {
    Grant(Grant),
    Authorizations(Vec<Authorization>),
}

impl LocalFileSystem {
    pub fn new(grant: Grant) -> Self {
        Self {
            files: ScopedFiles::new(grant.dir().clone()),
            authority: Authority::Grant(grant),
        }
    }

    pub fn from_authorization(authorization: Authorization) -> Self {
        Self {
            files: ScopedFiles::new(authorization.dir().clone()),
            authority: Authority::Authorizations(vec![authorization]),
        }
    }

    /// Binds the exact action proofs needed by a compound operation, preserving each lease.
    pub fn from_authorizations(
        first: Authorization,
        additional: impl IntoIterator<Item = Authorization>,
    ) -> Result<Self, FileSystemError> {
        let mut authorizations = vec![first];
        for authorization in additional {
            if authorization.dir() != authorizations[0].dir()
                || authorization.subject() != authorizations[0].subject()
            {
                return Err(FileSystemError::PermissionDenied(
                    "compound filesystem actions require one subject and directory".into(),
                ));
            }
            authorizations.push(authorization);
        }
        Ok(Self {
            files: ScopedFiles::new(authorizations[0].dir().clone()),
            authority: Authority::Authorizations(authorizations),
        })
    }

    fn execute<T>(
        &self,
        permission: Permission,
        operation: impl FnOnce(&ScopedFiles) -> Result<T, FileSystemError>,
    ) -> Result<T, FileSystemError> {
        let authorization = match &self.authority {
            Authority::Grant(grant) => grant
                .authorize(permission)
                .map_err(|error| FileSystemError::PermissionDenied(error.to_string()))?,
            Authority::Authorizations(authorizations) => authorizations
                .iter()
                .find(|authorization| authorization.permission() == permission)
                .cloned()
                .ok_or_else(|| {
                    FileSystemError::PermissionDenied(format!("missing {permission} authorization"))
                })?,
        };
        authorization
            .execute(authorization.subject(), &self.files.dir, permission, || {
                operation(&self.files)
            })
            .map_err(|error| FileSystemError::PermissionDenied(error.to_string()))?
    }
}

impl FileSystem for LocalFileSystem {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn paste_system_files(
        &self,
        directory: &Path,
        requested_operation: SystemFileTransferOperation,
    ) -> Result<bool, FileSystemError> {
        #[cfg(windows)]
        {
            let _ = requested_operation;
            return paste_windows_cut_files(self, directory);
        }
        #[cfg(target_os = "macos")]
        {
            return paste_macos_files(self, directory, requested_operation);
        }
        #[cfg(target_os = "linux")]
        {
            let _ = requested_operation;
            return paste_linux_files(self, directory);
        }
        #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
        {
            let _ = (directory, requested_operation);
            Ok(false)
        }
    }

    fn copy_to(
        &self,
        source: &Path,
        destination: &dyn FileSystem,
        target: &Path,
    ) -> Result<(), FileSystemError> {
        let destination = destination
            .as_any()
            .downcast_ref::<Self>()
            .ok_or_else(|| FileSystemError::Io("incompatible filesystem for copy".into()))?;
        self.execute(Permission::BrowseFiles, |_| {
            self.execute(Permission::ReadFiles, |source_files| {
                destination.execute(Permission::WriteFiles, |target_files| {
                    let _guard = target_files.dir.directory().lock_writes().map_err(|_| {
                        FileSystemError::Io("directory write lock is poisoned".into())
                    })?;
                    let source_path = source_files.resolve_existing(source)?;
                    let target_path = target_files.resolve_for_write(target)?;
                    let source_absolute = source_files.dir.canonical_path().join(&source_path);
                    let target_absolute = target_files.dir.canonical_path().join(&target_path);
                    if target_absolute.starts_with(&source_absolute) {
                        return Err(FileSystemError::InvalidPath(target.to_path_buf()));
                    }
                    if target_files
                        .handle()
                        .try_exists(&target_path)
                        .map_err(io_error)?
                    {
                        return Err(FileSystemError::AlreadyExists(target.to_path_buf()));
                    }
                    let parent = target_path
                        .parent()
                        .ok_or_else(|| FileSystemError::InvalidPath(target.to_path_buf()))?;
                    let parent = if parent.as_os_str().is_empty() {
                        Path::new(".")
                    } else {
                        parent
                    };
                    if !target_files.handle().is_dir(parent) {
                        return Err(FileSystemError::NotDirectory(target.to_path_buf()));
                    }
                    copy_resource(
                        source_files.handle(),
                        &source_path,
                        target_files.handle(),
                        &target_path,
                    )
                })
            })
        })
    }

    fn create_directory(&self, path: &Path) -> Result<FileMetadata, FileSystemError> {
        self.execute(Permission::WriteFiles, |files| {
            let _guard = files
                .dir
                .directory()
                .lock_writes()
                .map_err(|error| FileSystemError::Io(error.to_string()))?;
            let path = files.resolve_for_write(path)?;
            files.handle().create_dir_all(&path).map_err(io_error)?;
            metadata(files.handle(), &path)
        })
    }

    fn ensure_permission(&self, permission: Permission) -> Result<(), FileSystemError> {
        self.execute(permission, |_| Ok(()))
    }

    fn read_file(&self, path: &Path, maximum_bytes: usize) -> Result<Vec<u8>, FileSystemError> {
        self.execute(Permission::ReadFiles, |files| {
            files.read_file(path, maximum_bytes)
        })
    }
    fn read_file_with_revision(
        &self,
        path: &Path,
        maximum_bytes: usize,
    ) -> Result<FileContent, FileSystemError> {
        self.execute(Permission::ReadFiles, |files| {
            files.read_file_with_revision(path, maximum_bytes)
        })
    }
    fn write_file(
        &self,
        path: &Path,
        content: &[u8],
        maximum_bytes: usize,
    ) -> Result<FileMetadata, FileSystemError> {
        self.execute(Permission::WriteFiles, |files| {
            files.write_file(path, content, maximum_bytes)
        })
    }
    fn write_file_with_condition(
        &self,
        path: &Path,
        content: &[u8],
        maximum_bytes: usize,
        condition: &FileWriteCondition,
    ) -> Result<FileMetadata, FileSystemError> {
        self.execute(Permission::WriteFiles, |files| {
            files.write_file_with_condition(path, content, maximum_bytes, condition)
        })
    }
    fn get_metadata(&self, path: &Path) -> Result<FileMetadata, FileSystemError> {
        self.execute(Permission::BrowseFiles, |files| files.get_metadata(path))
    }
    fn read_directory(&self, path: &Path) -> Result<Vec<DirectoryEntry>, FileSystemError> {
        self.execute(Permission::BrowseFiles, |files| files.read_directory(path))
    }
    fn create_file(
        &self,
        path: &Path,
        existing: ExistingTargetBehavior,
    ) -> Result<FileMetadata, FileSystemError> {
        self.execute(Permission::WriteFiles, |files| {
            files.create_file(path, existing)
        })
    }
    fn rename(
        &self,
        source: &Path,
        target: &Path,
        existing: ExistingTargetBehavior,
    ) -> Result<(), FileSystemError> {
        self.execute(Permission::WriteFiles, |files| {
            files.rename(source, target, existing)
        })
    }
    fn delete(
        &self,
        path: &Path,
        missing: MissingTargetBehavior,
        mode: FileDeleteMode,
    ) -> Result<(), FileSystemError> {
        self.execute(Permission::WriteFiles, |files| {
            files.delete(path, missing, mode)
        })
    }
}

#[cfg(windows)]
fn paste_windows_cut_files(
    filesystem: &LocalFileSystem,
    directory: &Path,
) -> Result<bool, FileSystemError> {
    use clipboard_win::formats::{FileList, RawData};

    let drop_effect = clipboard_win::register_format("Preferred DropEffect")
        .ok_or_else(|| FileSystemError::Io("Cannot register Windows clipboard format".into()))?;
    let ash_format = clipboard_win::register_format("web application/x-ash-resources")
        .ok_or_else(|| FileSystemError::Io("Cannot register Ash clipboard format".into()))?;
    let clipboard = clipboard_win::Clipboard::new_attempts(10)
        .map_err(|error| FileSystemError::Io(error.to_string()))?;
    if clipboard_win::is_format_avail(ash_format.get())
        || !clipboard_win::is_format_avail(drop_effect.get())
    {
        return Ok(false);
    }
    let effect: Vec<u8> = clipboard_win::get(RawData(drop_effect.get()))
        .map_err(|error| FileSystemError::Io(error.to_string()))?;
    if effect.len() < 4 || u32::from_le_bytes(effect[..4].try_into().unwrap()) != 2 {
        return Ok(false);
    }
    let sources: Vec<PathBuf> =
        clipboard_win::get(FileList).map_err(|error| FileSystemError::Io(error.to_string()))?;
    let clipboard_sequence = clipboard_win::seq_num();
    drop(clipboard);
    transfer_system_files(
        filesystem,
        directory,
        &sources,
        SystemFileTransferOperation::Move,
    )?;
    if let (Some(before), Ok(_clipboard)) = (
        clipboard_sequence,
        clipboard_win::Clipboard::new_attempts(10),
    ) {
        if clipboard_win::seq_num() == Some(before) {
            clipboard_win::empty().map_err(|error| FileSystemError::Io(error.to_string()))?;
        }
    }
    Ok(true)
}

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
fn transfer_system_files(
    filesystem: &LocalFileSystem,
    directory: &Path,
    sources: &[PathBuf],
    operation: SystemFileTransferOperation,
) -> Result<(), FileSystemError> {
    if sources.is_empty()
        || sources.len() > 1024
        || sources.iter().any(|source| !source.is_absolute())
    {
        return Err(FileSystemError::InvalidPath(directory.to_path_buf()));
    }

    filesystem.execute(Permission::WriteFiles, |target_files| {
        let _guard = target_files
            .dir
            .directory()
            .lock_writes()
            .map_err(|_| FileSystemError::Io("directory write lock is poisoned".into()))?;
        let target_directory = target_files.resolve_existing(directory)?;
        if !target_files.handle().is_dir(&target_directory) {
            return Err(FileSystemError::NotDirectory(directory.to_path_buf()));
        }
        let destination = target_files.dir.canonical_path().join(&target_directory);
        let canonical_sources: Vec<PathBuf> = sources
            .iter()
            .map(|source| {
                let kind = std::fs::symlink_metadata(source)
                    .map_err(io_error)?
                    .file_type();
                if kind.is_symlink() || (!kind.is_file() && !kind.is_dir()) {
                    return Err(FileSystemError::InvalidPath(source.clone()));
                }
                source.canonicalize().map_err(io_error)
            })
            .collect::<Result<_, _>>()?;
        for (index, source) in canonical_sources.iter().enumerate() {
            if canonical_sources
                .iter()
                .enumerate()
                .any(|(other_index, other)| index != other_index && source.starts_with(other))
            {
                return Err(FileSystemError::InvalidPath(source.clone()));
            }
            if target_files.dir.canonical_path().starts_with(source)
                || destination.starts_with(source)
            {
                return Err(FileSystemError::InvalidPath(source.clone()));
            }
        }

        let mut reserved = std::collections::HashSet::new();
        let mut transfers = Vec::new();
        for source in &canonical_sources {
            if operation == SystemFileTransferOperation::Move
                && source.parent() == Some(destination.as_path())
            {
                continue;
            }
            let name = source
                .file_name()
                .ok_or_else(|| FileSystemError::InvalidPath(source.clone()))?;
            let stem = source.file_stem().unwrap_or(name);
            let extension = source.extension();
            let mut target: Option<PathBuf> = None;
            for index in 0..10_000 {
                let mut candidate_name = OsString::from(stem);
                if index > 0 {
                    candidate_name.push(" copy");
                    if index > 1 {
                        candidate_name.push(format!(" {index}"));
                    }
                }
                if let Some(extension) = extension {
                    candidate_name.push(".");
                    candidate_name.push(extension);
                }
                let candidate = target_directory.join(candidate_name);
                if !reserved.insert(candidate.to_string_lossy().to_lowercase()) {
                    continue;
                }
                if !target_files
                    .handle()
                    .try_exists(&candidate)
                    .map_err(io_error)?
                {
                    target = Some(candidate);
                    break;
                }
            }
            let target =
                target.ok_or_else(|| FileSystemError::AlreadyExists(destination.join(name)))?;
            transfers.push((source, target));
        }
        let mut copied_targets = Vec::new();
        let copied = (|| {
            for (source, target) in &transfers {
                let parent = source
                    .parent()
                    .ok_or_else(|| FileSystemError::InvalidPath(source.to_path_buf()))?;
                let name = source
                    .file_name()
                    .ok_or_else(|| FileSystemError::InvalidPath(source.to_path_buf()))?;
                let source_directory =
                    Directory::open_ambient_dir(parent, cap_std::ambient_authority())
                        .map_err(io_error)?;
                copy_resource(
                    &source_directory,
                    Path::new(name),
                    target_files.handle(),
                    target,
                )?;
                copied_targets.push(target.clone());
            }
            Ok::<(), FileSystemError>(())
        })();
        if let Err(error) = copied {
            for copied in copied_targets.iter().rev() {
                let _ = remove_resource(target_files.handle(), copied, FileDeleteMode::Recursive);
            }
            return Err(error);
        }
        if operation == SystemFileTransferOperation::Move {
            for (source, _) in transfers {
                let parent = source
                    .parent()
                    .ok_or_else(|| FileSystemError::InvalidPath(source.clone()))?;
                let name = source
                    .file_name()
                    .ok_or_else(|| FileSystemError::InvalidPath(source.clone()))?;
                let source_directory =
                    Directory::open_ambient_dir(parent, cap_std::ambient_authority())
                        .map_err(io_error)?;
                if source_directory
                    .symlink_metadata(name)
                    .map_err(io_error)?
                    .is_dir()
                {
                    source_directory.remove_dir_all(name).map_err(io_error)?;
                } else {
                    source_directory.remove_file(name).map_err(io_error)?;
                }
            }
        }
        Ok(())
    })
}

#[cfg(target_os = "macos")]
fn paste_macos_files(
    filesystem: &LocalFileSystem,
    directory: &Path,
    requested_operation: SystemFileTransferOperation,
) -> Result<bool, FileSystemError> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|error| FileSystemError::Io(error.to_string()))?;
    let sources = match clipboard.get().file_list() {
        Ok(sources) if !sources.is_empty() => sources,
        Ok(_) | Err(arboard::Error::ContentNotAvailable) => return Ok(false),
        Err(error) => return Err(FileSystemError::Io(error.to_string())),
    };
    transfer_system_files(filesystem, directory, &sources, requested_operation)?;
    if requested_operation == SystemFileTransferOperation::Move
        && clipboard.get().file_list().ok().as_ref() == Some(&sources)
    {
        clipboard
            .clear()
            .map_err(|error| FileSystemError::Io(error.to_string()))?;
    }
    Ok(true)
}

#[cfg(target_os = "linux")]
fn paste_linux_files(
    filesystem: &LocalFileSystem,
    directory: &Path,
) -> Result<bool, FileSystemError> {
    if std::env::var_os("DISPLAY").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_none() {
        return Ok(false);
    }
    let gnome = read_linux_clipboard_format("x-special/gnome-copied-files")?;
    let mut uri_list = None;
    let (sources, operation) = if let Some(data) = &gnome {
        parse_gnome_copied_files(data)?
    } else {
        let data = match read_linux_clipboard_format("text/uri-list")? {
            Some(data) => data,
            None => return Ok(false),
        };
        let sources = parse_file_uri_list(&data)?;
        uri_list = Some(data);
        let kde = read_linux_clipboard_format("application/x-kde-cutselection")?;
        (
            sources,
            if kde.as_deref() == Some(b"1") {
                SystemFileTransferOperation::Move
            } else {
                SystemFileTransferOperation::Copy
            },
        )
    };
    if sources.is_empty() {
        return Ok(false);
    }
    transfer_system_files(filesystem, directory, &sources, operation)?;
    if operation == SystemFileTransferOperation::Move {
        let mut clipboard =
            arboard::Clipboard::new().map_err(|error| FileSystemError::Io(error.to_string()))?;
        let unchanged = if let Some(data) = &gnome {
            read_linux_clipboard_format("x-special/gnome-copied-files")?.as_ref() == Some(data)
        } else {
            read_linux_clipboard_format("text/uri-list")?.as_ref() == uri_list.as_ref()
        };
        if unchanged {
            clipboard
                .clear()
                .map_err(|error| FileSystemError::Io(error.to_string()))?;
        }
    }
    Ok(true)
}

#[cfg(target_os = "linux")]
fn parse_gnome_copied_files(
    data: &[u8],
) -> Result<(Vec<PathBuf>, SystemFileTransferOperation), FileSystemError> {
    let content =
        std::str::from_utf8(data).map_err(|error| FileSystemError::Io(error.to_string()))?;
    let mut lines = content.lines();
    let operation = match lines.next().map(|line| line.trim_end_matches('\r')) {
        Some("cut") => SystemFileTransferOperation::Move,
        Some("copy") => SystemFileTransferOperation::Copy,
        _ => {
            return Err(FileSystemError::Io(
                "Invalid GNOME clipboard operation".into(),
            ));
        }
    };
    let sources = parse_file_urls(lines)?;
    Ok((sources, operation))
}

#[cfg(target_os = "linux")]
fn parse_file_uri_list(data: &[u8]) -> Result<Vec<PathBuf>, FileSystemError> {
    let content =
        std::str::from_utf8(data).map_err(|error| FileSystemError::Io(error.to_string()))?;
    parse_file_urls(content.lines().filter(|line| !line.starts_with('#')))
}

#[cfg(target_os = "linux")]
fn parse_file_urls<'a>(
    lines: impl Iterator<Item = &'a str>,
) -> Result<Vec<PathBuf>, FileSystemError> {
    lines
        .map(|line| line.trim_end_matches('\r'))
        .filter(|line| !line.is_empty())
        .map(|line| {
            url::Url::parse(line)
                .ok()
                .and_then(|uri| uri.to_file_path().ok())
                .ok_or_else(|| FileSystemError::Io("Invalid clipboard file URL".into()))
        })
        .collect()
}

#[cfg(target_os = "linux")]
fn read_linux_clipboard_format(format: &str) -> Result<Option<Vec<u8>>, FileSystemError> {
    if std::env::var_os("WAYLAND_DISPLAY").is_some()
        && wl_clipboard_rs::utils::is_primary_selection_supported().is_ok()
    {
        use wl_clipboard_rs::paste::{ClipboardType, Error, MimeType, Seat, get_contents};
        let result = get_contents(
            ClipboardType::Regular,
            Seat::Unspecified,
            MimeType::Specific(format),
        );
        return match result {
            Ok((pipe, _)) => {
                let mut data = Vec::new();
                pipe.take(1024 * 1024 + 1)
                    .read_to_end(&mut data)
                    .map_err(io_error)?;
                if data.len() > 1024 * 1024 {
                    return Err(FileSystemError::Io(
                        "Clipboard file list is too large".into(),
                    ));
                }
                Ok(Some(data))
            }
            Err(Error::ClipboardEmpty | Error::NoMimeType) => Ok(None),
            Err(error) => Err(FileSystemError::Io(error.to_string())),
        };
    }
    if std::env::var_os("DISPLAY").is_none() {
        return Ok(None);
    }
    read_x11_clipboard_format(format)
}

#[cfg(target_os = "linux")]
fn read_x11_clipboard_format(format: &str) -> Result<Option<Vec<u8>>, FileSystemError> {
    use x11rb::connection::Connection;
    use x11rb::protocol::Event;
    use x11rb::protocol::xproto::{
        AtomEnum, ConnectionExt, CreateWindowAux, EventMask, Property, WindowClass,
    };

    let (connection, screen_index) =
        x11rb::connect(None).map_err(|error| FileSystemError::Io(error.to_string()))?;
    let screen = &connection.setup().roots[screen_index];
    let clipboard = connection
        .intern_atom(false, b"CLIPBOARD")
        .map_err(|error| FileSystemError::Io(error.to_string()))?
        .reply()
        .map_err(|error| FileSystemError::Io(error.to_string()))?
        .atom;
    if connection
        .get_selection_owner(clipboard)
        .map_err(|error| FileSystemError::Io(error.to_string()))?
        .reply()
        .map_err(|error| FileSystemError::Io(error.to_string()))?
        .owner
        == x11rb::NONE
    {
        return Ok(None);
    }
    let target = connection
        .intern_atom(false, format.as_bytes())
        .map_err(|error| FileSystemError::Io(error.to_string()))?
        .reply()
        .map_err(|error| FileSystemError::Io(error.to_string()))?
        .atom;
    let property = connection
        .intern_atom(false, b"ASH_CLIPBOARD_TRANSFER")
        .map_err(|error| FileSystemError::Io(error.to_string()))?
        .reply()
        .map_err(|error| FileSystemError::Io(error.to_string()))?
        .atom;
    let incr = connection
        .intern_atom(false, b"INCR")
        .map_err(|error| FileSystemError::Io(error.to_string()))?
        .reply()
        .map_err(|error| FileSystemError::Io(error.to_string()))?
        .atom;
    let window = connection
        .generate_id()
        .map_err(|error| FileSystemError::Io(error.to_string()))?;
    connection
        .create_window(
            x11rb::COPY_DEPTH_FROM_PARENT,
            window,
            screen.root,
            0,
            0,
            1,
            1,
            0,
            WindowClass::INPUT_ONLY,
            0,
            &CreateWindowAux::new().event_mask(EventMask::PROPERTY_CHANGE),
        )
        .map_err(|error| FileSystemError::Io(error.to_string()))?;
    connection
        .convert_selection(window, clipboard, target, property, x11rb::CURRENT_TIME)
        .map_err(|error| FileSystemError::Io(error.to_string()))?;
    connection
        .flush()
        .map_err(|error| FileSystemError::Io(error.to_string()))?;
    let mut incremental = false;
    let mut data = Vec::new();
    let mut deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        if std::time::Instant::now() >= deadline {
            return Err(FileSystemError::Io("Clipboard request timed out".into()));
        }
        match connection
            .poll_for_event()
            .map_err(|error| FileSystemError::Io(error.to_string()))?
        {
            Some(Event::SelectionNotify(event))
                if !incremental
                    && event.requestor == window
                    && event.selection == clipboard
                    && event.target == target =>
            {
                if event.property == x11rb::NONE {
                    return Ok(None);
                }
                let reply = connection
                    .get_property(true, window, property, AtomEnum::ANY, 0, 262_145)
                    .map_err(|error| FileSystemError::Io(error.to_string()))?
                    .reply()
                    .map_err(|error| FileSystemError::Io(error.to_string()))?;
                if reply.bytes_after > 0 || reply.value.len() > 1024 * 1024 {
                    return Err(FileSystemError::Io(
                        "Clipboard file list is too large".into(),
                    ));
                }
                if reply.type_ == incr {
                    // Deleting the INCR header acknowledges readiness for PropertyNotify chunks.
                    incremental = true;
                    connection
                        .flush()
                        .map_err(|error| FileSystemError::Io(error.to_string()))?;
                    deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
                } else if reply.type_ == target && reply.format == 8 {
                    return Ok(Some(reply.value));
                } else {
                    return Err(FileSystemError::Io(
                        "Invalid clipboard property type".into(),
                    ));
                }
            }
            Some(Event::PropertyNotify(event))
                if incremental
                    && event.window == window
                    && event.atom == property
                    && event.state == Property::NEW_VALUE =>
            {
                let reply = connection
                    .get_property(true, window, property, AtomEnum::ANY, 0, 262_145)
                    .map_err(|error| FileSystemError::Io(error.to_string()))?
                    .reply()
                    .map_err(|error| FileSystemError::Io(error.to_string()))?;
                if reply.type_ != target || reply.format != 8 {
                    return Err(FileSystemError::Io(
                        "Invalid clipboard property type".into(),
                    ));
                }
                if reply.bytes_after > 0 || reply.value.len() > 1024 * 1024 - data.len() {
                    return Err(FileSystemError::Io(
                        "Clipboard file list is too large".into(),
                    ));
                }
                if reply.value.is_empty() {
                    return Ok(Some(data));
                }
                data.extend_from_slice(&reply.value);
                connection
                    .flush()
                    .map_err(|error| FileSystemError::Io(error.to_string()))?;
                deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
            }
            None => std::thread::sleep(std::time::Duration::from_millis(5)),
            _ => {}
        }
    }
}

fn copy_resource(
    source_dir: &Directory,
    source: &Path,
    target_dir: &Directory,
    target: &Path,
) -> Result<(), FileSystemError> {
    let kind = source_dir
        .symlink_metadata(source)
        .map_err(io_error)?
        .file_type();
    if kind.is_symlink() {
        return Err(FileSystemError::InvalidPath(source.to_path_buf()));
    }
    if kind.is_file() {
        let mut from = source_dir.open(source).map_err(io_error)?;
        let mut to = target_dir
            .open_with(target, OpenOptions::new().write(true).create_new(true))
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    FileSystemError::AlreadyExists(target.to_path_buf())
                } else {
                    io_error(error)
                }
            })?;
        let result = std::io::copy(&mut from, &mut to)
            .and_then(|_| {
                target_dir.set_permissions(target, source_dir.metadata(source)?.permissions())
            })
            .map_err(io_error);
        if result.is_err() {
            let _ = target_dir.remove_file(target);
        }
        return result;
    }
    if !kind.is_dir() {
        return Err(FileSystemError::NotFile(source.to_path_buf()));
    }
    let permissions = source_dir.metadata(source).map_err(io_error)?.permissions();
    #[cfg(unix)]
    let created = {
        use cap_std::fs::DirBuilderExt;
        // Keep children private while copying; apply the source's possibly read-only mode last.
        let mut builder = cap_std::fs::DirBuilder::new();
        builder.mode(0o700);
        target_dir.create_dir_with(target, &builder)
    };
    #[cfg(not(unix))]
    let created = target_dir.create_dir(target);
    created.map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            FileSystemError::AlreadyExists(target.to_path_buf())
        } else {
            io_error(error)
        }
    })?;
    let result = (|| {
        for entry in source_dir.read_dir(source).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            let name = entry.file_name();
            copy_resource(
                source_dir,
                &source.join(&name),
                target_dir,
                &target.join(&name),
            )?;
        }
        target_dir
            .set_permissions(target, permissions)
            .map_err(io_error)
    })();
    if result.is_err() {
        let _ = target_dir.remove_dir_all(target);
    }
    result
}

/// Local implementation that confines all operations to one canonical directory.
struct ScopedFiles {
    dir: Dir,
}

/// Commits mutations under the same directory lock as ordinary conditional writes.
/// The host owns directory authorization for this entire operation.
/// All revisions and temporary writes are prepared before the first publication.
/// Filesystems do not offer a cross-file transaction: publication errors report
/// completed paths rather than attempting a rollback over another writer's work.
pub fn commit_file_mutations(
    dir: &Dir,
    mutations: &[FileMutation],
) -> Result<(), FileMutationError> {
    let files = ScopedFiles::new(dir.clone());
    let mut completed_paths = Vec::new();
    let mut publication_started = false;
    let result = (|| {
        let _guard = dir
            .directory()
            .lock_writes()
            .map_err(|error| FileSystemError::Io(error.to_string()))?;
        let staged = mutations
            .iter()
            .map(|mutation| {
                validate_file_mutation(&files, mutation)?;
                let (path, content, permissions) = match mutation {
                    FileMutation::Create { path, content } => (path, content, None),
                    FileMutation::Replace { path, content, .. } => {
                        let source = files.resolve_existing(path)?;
                        (
                            path,
                            content,
                            Some(
                                files
                                    .handle()
                                    .metadata(source)
                                    .map_err(io_error)?
                                    .permissions(),
                            ),
                        )
                    }
                    FileMutation::MoveAndReplace {
                        path,
                        target,
                        content,
                        ..
                    } => {
                        let source = files.resolve_existing(path)?;
                        (
                            target,
                            content,
                            Some(
                                files
                                    .handle()
                                    .metadata(source)
                                    .map_err(io_error)?
                                    .permissions(),
                            ),
                        )
                    }
                    FileMutation::Remove { .. } => return Ok(None),
                };
                let target = files.resolve_for_write(path)?;
                PreparedWrite::new(files.handle(), &target, content, permissions)
                    .map(Some)
                    .map_err(io_error)
            })
            .collect::<Result<Vec<_>, FileSystemError>>()?;
        for (mutation, write) in mutations.iter().zip(staged) {
            // Recheck changes made by other processes while temporary files were
            // written. The directory lock serializes Ash writers, not external apps.
            validate_file_mutation(&files, mutation)?;
            match mutation {
                FileMutation::Create { path, .. } => {
                    publication_started = true;
                    write
                        .expect("create was staged")
                        .publish(WritePublication::Create)
                        .map_err(io_error)?;
                    completed_paths.push(path.clone());
                }
                FileMutation::Replace { path, .. } => {
                    publication_started = true;
                    write
                        .expect("replacement was staged")
                        .publish(WritePublication::Replace)
                        .map_err(io_error)?;
                    completed_paths.push(path.clone());
                }
                FileMutation::Remove { path, .. } => {
                    let source = files.resolve_existing(path)?;
                    publication_started = true;
                    files.handle().remove_file(source).map_err(io_error)?;
                    completed_paths.push(path.clone());
                }
                FileMutation::MoveAndReplace {
                    path,
                    target,
                    expected_revision,
                    ..
                } => {
                    publication_started = true;
                    write
                        .expect("move was staged")
                        .publish(WritePublication::Create)
                        .map_err(io_error)?;
                    completed_paths.push(target.clone());
                    check_file_revision(&files, path, expected_revision)?;
                    let source = files.resolve_existing(path)?;
                    files.handle().remove_file(source).map_err(io_error)?;
                    completed_paths.push(path.clone());
                }
            }
        }
        Ok(())
    })();
    result.map_err(|source| FileMutationError {
        source,
        completed_paths,
        publication_started,
    })
}

fn check_file_revision(
    files: &ScopedFiles,
    path: &Path,
    expected: &str,
) -> Result<(), FileSystemError> {
    let resolved = files.resolve_existing(path)?;
    let metadata = files.handle().metadata(&resolved).map_err(io_error)?;
    if !metadata.is_file() {
        return Err(FileSystemError::NotFile(path.to_path_buf()));
    }
    if metadata.permissions().readonly() {
        return Err(FileSystemError::ReadOnly(path.to_path_buf()));
    }
    if file_revision(&files.handle().read(resolved).map_err(io_error)?) != expected {
        return Err(FileSystemError::RevisionConflict(path.to_path_buf()));
    }
    Ok(())
}

fn check_missing_file(files: &ScopedFiles, path: &Path) -> Result<(), FileSystemError> {
    let target = files.resolve_for_write(path)?;
    if files.handle().try_exists(target).map_err(io_error)? {
        return Err(FileSystemError::AlreadyExists(path.to_path_buf()));
    }
    Ok(())
}

fn validate_file_mutation(
    files: &ScopedFiles,
    mutation: &FileMutation,
) -> Result<(), FileSystemError> {
    match mutation {
        FileMutation::Create { path, .. } => check_missing_file(files, path),
        FileMutation::Replace {
            path,
            expected_revision,
            ..
        }
        | FileMutation::Remove {
            path,
            expected_revision,
        } => check_file_revision(files, path, expected_revision),
        FileMutation::MoveAndReplace {
            path,
            target,
            expected_revision,
            ..
        } => {
            check_file_revision(files, path, expected_revision)?;
            check_missing_file(files, target)
        }
    }
}

impl ScopedFiles {
    pub fn new(dir: Dir) -> Self {
        Self { dir }
    }

    fn resolve_existing(&self, path: &Path) -> Result<PathBuf, FileSystemError> {
        match self.dir.resolve_existing(path) {
            Ok(resolved) => self.relative(resolved),
            Err(_) => match self.dir.resolve_for_write(path) {
                Ok(candidate) if candidate.try_exists().map_err(io_error)? => {
                    Err(FileSystemError::InvalidPath(path.to_path_buf()))
                }
                Ok(_) => Err(FileSystemError::NotFound(path.to_path_buf())),
                Err(_) => Err(FileSystemError::InvalidPath(path.to_path_buf())),
            },
        }
    }

    fn resolve_for_write(&self, path: &Path) -> Result<PathBuf, FileSystemError> {
        let resolved = self
            .dir
            .resolve_for_write(path)
            .map_err(|_| FileSystemError::InvalidPath(path.to_path_buf()))?;
        self.relative(resolved)
    }

    fn handle(&self) -> &Directory {
        self.dir.directory().handle()
    }

    fn relative(&self, path: PathBuf) -> Result<PathBuf, FileSystemError> {
        path.strip_prefix(self.dir.canonical_path())
            .map(|path| {
                if path.as_os_str().is_empty() {
                    PathBuf::from(".")
                } else {
                    path.to_path_buf()
                }
            })
            .map_err(|_| FileSystemError::InvalidPath(path))
    }

    fn write_file_inner(
        &self,
        path: &Path,
        content: &[u8],
        maximum_bytes: usize,
        publication: WritePublication,
    ) -> Result<FileMetadata, FileSystemError> {
        if content.len() > maximum_bytes {
            return Err(FileSystemError::WriteLimitExceeded { maximum_bytes });
        }
        let resolved = self.resolve_for_write(path)?;
        let existing_metadata = match self.handle().metadata(&resolved) {
            Ok(metadata) => {
                if !metadata.is_file() {
                    return Err(FileSystemError::NotFile(path.to_path_buf()));
                }
                if metadata.permissions().readonly() {
                    return Err(FileSystemError::ReadOnly(path.to_path_buf()));
                }
                Some(metadata)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(io_error(error)),
        };
        let parent = resolved
            .parent()
            .ok_or_else(|| FileSystemError::InvalidPath(path.to_path_buf()))?;
        let parent = if parent.as_os_str().is_empty() {
            Path::new(".")
        } else {
            parent
        };
        let parent_metadata = self.handle().metadata(parent).map_err(io_error)?;
        if !parent_metadata.is_dir() {
            return Err(FileSystemError::NotDirectory(
                path.parent().unwrap_or(Path::new("")).to_path_buf(),
            ));
        }
        atomic_write(
            self.handle(),
            &resolved,
            content,
            existing_metadata
                .as_ref()
                .map(cap_std::fs::Metadata::permissions),
            publication,
        )
        .map_err(|error| match (publication, error.kind()) {
            (WritePublication::Create, std::io::ErrorKind::AlreadyExists) => {
                FileSystemError::AlreadyExists(path.to_path_buf())
            }
            (WritePublication::MissingOrEmpty, std::io::ErrorKind::AlreadyExists) => {
                FileSystemError::RevisionConflict(path.to_path_buf())
            }
            _ => io_error(error),
        })?;
        metadata(self.handle(), &resolved)
    }
}

impl ScopedFiles {
    fn read_file(&self, path: &Path, maximum_bytes: usize) -> Result<Vec<u8>, FileSystemError> {
        if maximum_bytes == 0 {
            return Err(FileSystemError::ReadLimitExceeded { maximum_bytes });
        }
        let resolved = self.resolve_existing(path)?;
        let mut file = self.handle().open(resolved).map_err(io_error)?;
        let mut bytes = Vec::with_capacity(maximum_bytes.min(8 * 1024));
        Read::by_ref(&mut file)
            .take((maximum_bytes + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(io_error)?;
        if bytes.len() > maximum_bytes {
            return Err(FileSystemError::ReadLimitExceeded { maximum_bytes });
        }
        Ok(bytes)
    }

    fn write_file(
        &self,
        path: &Path,
        content: &[u8],
        maximum_bytes: usize,
    ) -> Result<FileMetadata, FileSystemError> {
        let _guard = self
            .dir
            .directory()
            .lock_writes()
            .map_err(|_| FileSystemError::Io("directory write lock is poisoned".into()))?;
        self.write_file_inner(path, content, maximum_bytes, WritePublication::Replace)
    }

    fn read_file_with_revision(
        &self,
        path: &Path,
        maximum_bytes: usize,
    ) -> Result<FileContent, FileSystemError> {
        let bytes = self.read_file(path, maximum_bytes)?;
        Ok(FileContent {
            revision: file_revision(&bytes),
            bytes,
        })
    }

    fn write_file_with_condition(
        &self,
        path: &Path,
        content: &[u8],
        maximum_bytes: usize,
        condition: &FileWriteCondition,
    ) -> Result<FileMetadata, FileSystemError> {
        let _guard = self
            .dir
            .directory()
            .lock_writes()
            .map_err(|_| FileSystemError::Io("directory write lock is poisoned".into()))?;
        let publication = match condition {
            FileWriteCondition::Unconditional => WritePublication::Replace,
            FileWriteCondition::ExpectedRevision(expected) => {
                let current = self.read_file(path, maximum_bytes)?;
                if file_revision(&current) != *expected {
                    return Err(FileSystemError::RevisionConflict(path.to_path_buf()));
                }
                WritePublication::Replace
            }
            FileWriteCondition::MissingOrEmpty => WritePublication::MissingOrEmpty,
        };
        self.write_file_inner(path, content, maximum_bytes, publication)
    }

    fn get_metadata(&self, path: &Path) -> Result<FileMetadata, FileSystemError> {
        let resolved = self.resolve_existing(path)?;
        metadata(self.handle(), &resolved)
    }

    fn read_directory(&self, path: &Path) -> Result<Vec<DirectoryEntry>, FileSystemError> {
        let resolved = self.resolve_existing(path)?;
        if !self.handle().is_dir(&resolved) {
            return Err(FileSystemError::NotDirectory(path.to_path_buf()));
        }
        let mut entries = self
            .handle()
            .read_dir(resolved)
            .map_err(io_error)?
            .map(|entry| {
                let entry = entry.map_err(io_error)?;
                let entry_type = entry.file_type().map_err(io_error)?;
                Ok(DirectoryEntry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    file_type: file_type(entry_type),
                })
            })
            .collect::<Result<Vec<_>, FileSystemError>>()?;
        entries.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(entries)
    }

    fn create_file(
        &self,
        path: &Path,
        existing: ExistingTargetBehavior,
    ) -> Result<FileMetadata, FileSystemError> {
        let _guard = self
            .dir
            .directory()
            .lock_writes()
            .map_err(|_| FileSystemError::Io("directory write lock is poisoned".into()))?;
        let resolved = self.resolve_for_write(path)?;
        if self.handle().try_exists(&resolved).map_err(io_error)? {
            return match existing {
                ExistingTargetBehavior::Error => {
                    Err(FileSystemError::AlreadyExists(path.to_path_buf()))
                }
                ExistingTargetBehavior::Ignore => metadata(self.handle(), &resolved),
                ExistingTargetBehavior::Overwrite => {
                    self.write_file_inner(path, &[], 1, WritePublication::Replace)
                }
            };
        }
        let publication = match existing {
            ExistingTargetBehavior::Overwrite => WritePublication::Replace,
            ExistingTargetBehavior::Error | ExistingTargetBehavior::Ignore => {
                WritePublication::Create
            }
        };
        match self.write_file_inner(path, &[], 1, publication) {
            Err(FileSystemError::AlreadyExists(_))
                if existing == ExistingTargetBehavior::Ignore =>
            {
                metadata(self.handle(), &resolved)
            }
            result => result,
        }
    }

    fn rename(
        &self,
        source: &Path,
        target: &Path,
        existing: ExistingTargetBehavior,
    ) -> Result<(), FileSystemError> {
        let _guard = self
            .dir
            .directory()
            .lock_writes()
            .map_err(|_| FileSystemError::Io("directory write lock is poisoned".into()))?;
        let source_path = self.resolve_existing(source)?;
        let target_path = self.resolve_for_write(target)?;
        if source_path == target_path {
            return Ok(());
        }
        if self.handle().try_exists(&target_path).map_err(io_error)? {
            match existing {
                ExistingTargetBehavior::Error => {
                    return Err(FileSystemError::AlreadyExists(target.to_path_buf()));
                }
                ExistingTargetBehavior::Ignore => return Ok(()),
                ExistingTargetBehavior::Overwrite => {
                    let backup = rename_backup_path(self.handle(), &target_path)?;
                    self.handle()
                        .rename(&target_path, self.handle(), &backup)
                        .map_err(io_error)?;
                    if let Err(error) =
                        self.handle()
                            .rename(&source_path, self.handle(), &target_path)
                    {
                        let _ = self.handle().rename(&backup, self.handle(), &target_path);
                        return Err(io_error(error));
                    }
                    let _ = remove_resource(self.handle(), &backup, FileDeleteMode::Recursive);
                    return Ok(());
                }
            }
        }
        let parent = target_path
            .parent()
            .ok_or_else(|| FileSystemError::InvalidPath(target.to_path_buf()))?;
        let parent = if parent.as_os_str().is_empty() {
            Path::new(".")
        } else {
            parent
        };
        if !self.handle().is_dir(parent) {
            return Err(FileSystemError::NotDirectory(
                target.parent().unwrap_or(Path::new("")).to_path_buf(),
            ));
        }
        self.handle()
            .rename(source_path, self.handle(), target_path)
            .map_err(io_error)
    }

    fn delete(
        &self,
        path: &Path,
        missing: MissingTargetBehavior,
        mode: FileDeleteMode,
    ) -> Result<(), FileSystemError> {
        let _guard = self
            .dir
            .directory()
            .lock_writes()
            .map_err(|_| FileSystemError::Io("directory write lock is poisoned".into()))?;
        let candidate = self.resolve_for_write(path)?;
        if !self.handle().try_exists(&candidate).map_err(io_error)? {
            return match missing {
                MissingTargetBehavior::Error => Err(FileSystemError::NotFound(path.to_path_buf())),
                MissingTargetBehavior::Ignore => Ok(()),
            };
        }
        let resolved = self.resolve_existing(path)?;
        remove_resource(self.handle(), &resolved, mode)
    }
}

fn rename_backup_path(dir: &Directory, target: &Path) -> Result<PathBuf, FileSystemError> {
    let parent = target
        .parent()
        .ok_or_else(|| FileSystemError::InvalidPath(target.to_path_buf()))?;
    for sequence in 0..1_024u32 {
        let candidate = parent.join(format!(
            ".ash-rename-backup-{}-{sequence}",
            std::process::id()
        ));
        if !dir.try_exists(&candidate).map_err(io_error)? {
            return Ok(candidate);
        }
    }
    Err(FileSystemError::Io(
        "could not allocate a directory rename backup path".into(),
    ))
}

fn remove_resource(
    dir: &Directory,
    path: &Path,
    mode: FileDeleteMode,
) -> Result<(), FileSystemError> {
    let metadata = dir.symlink_metadata(path).map_err(io_error)?;
    if metadata.file_type().is_dir() {
        match mode {
            FileDeleteMode::FileOrEmptyDirectory => dir.remove_dir(path).map_err(io_error),
            FileDeleteMode::Recursive => dir.remove_dir_all(path).map_err(io_error),
        }
    } else {
        dir.remove_file(path).map_err(io_error)
    }
}

#[derive(Clone, Copy)]
enum WritePublication {
    Replace,
    Create,
    MissingOrEmpty,
}

struct PreparedWrite<'a> {
    parent: Directory,
    target: OsString,
    temporary: String,
    content: &'a [u8],
    remove_temporary_on_drop: bool,
}

impl<'a> PreparedWrite<'a> {
    fn new(
        root: &Directory,
        target: &Path,
        content: &'a [u8],
        permissions: Option<cap_std::fs::Permissions>,
    ) -> std::io::Result<Self> {
        let parent = target
            .parent()
            .ok_or_else(|| std::io::Error::other("write target has no parent"))?;
        let parent = root.open_dir(if parent.as_os_str().is_empty() {
            Path::new(".")
        } else {
            parent
        })?;
        let target = target
            .file_name()
            .ok_or_else(|| std::io::Error::other("write target has no file name"))?
            .to_os_string();
        static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let (temporary, mut file) = loop {
            let name = format!(
                ".ash-write-{}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            );
            match parent.open_with(&name, OpenOptions::new().write(true).create_new(true)) {
                Ok(file) => break (name, file),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        };
        let result = (|| {
            file.write_all(content)?;
            if let Some(permissions) = permissions {
                file.set_permissions(permissions)?;
            }
            file.sync_all()
        })();
        if let Err(error) = result {
            let _ = parent.remove_file(&temporary);
            return Err(error);
        }
        Ok(Self {
            parent,
            target,
            temporary,
            content,
            remove_temporary_on_drop: true,
        })
    }

    fn publish(mut self, publication: WritePublication) -> std::io::Result<()> {
        match publication {
            WritePublication::Replace => {
                self.parent
                    .rename(&self.temporary, &self.parent, &self.target)?;
                self.remove_temporary_on_drop = false;
            }
            WritePublication::Create => {
                self.parent
                    .hard_link(&self.temporary, &self.parent, &self.target)?;
                self.parent.remove_file(&self.temporary)?;
                self.remove_temporary_on_drop = false;
            }
            WritePublication::MissingOrEmpty => {
                match self
                    .parent
                    .hard_link(&self.temporary, &self.parent, &self.target)
                {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                        let mut existing = self
                            .parent
                            .open_with(&self.target, OpenOptions::new().append(true))?;
                        if existing.metadata()?.len() != 0
                            || FileInformation::from_file(&existing.try_clone()?.into_std())?
                                .has_multiple_links()
                        {
                            return Err(error);
                        }
                        existing.write_all(self.content)?;
                        existing.sync_all()?;
                    }
                    Err(error) => return Err(error),
                }
                self.parent.remove_file(&self.temporary)?;
                self.remove_temporary_on_drop = false;
            }
        }
        #[cfg(unix)]
        // cap-std may hold directories with O_PATH on Linux; reopen for a syncable descriptor.
        self.parent.open(".")?.sync_all()?;
        Ok(())
    }
}

impl Drop for PreparedWrite<'_> {
    fn drop(&mut self) {
        if self.remove_temporary_on_drop {
            let _ = self.parent.remove_file(&self.temporary);
        }
    }
}

fn atomic_write(
    root: &Directory,
    target: &Path,
    content: &[u8],
    permissions: Option<cap_std::fs::Permissions>,
    publication: WritePublication,
) -> std::io::Result<()> {
    PreparedWrite::new(root, target, content, permissions)?.publish(publication)
}

fn metadata(dir: &Directory, path: &Path) -> Result<FileMetadata, FileSystemError> {
    let metadata = dir.symlink_metadata(path).map_err(io_error)?;
    Ok(FileMetadata {
        file_type: file_type(metadata.file_type()),
        size_bytes: metadata.len(),
        readonly: metadata.permissions().readonly(),
        modified_at_millis: metadata
            .modified()
            .ok()
            .and_then(|modified| modified.into_std().duration_since(UNIX_EPOCH).ok())
            .and_then(|duration| u64::try_from(duration.as_millis()).ok()),
    })
}

fn file_type(file_type: cap_std::fs::FileType) -> FileType {
    if file_type.is_dir() {
        FileType::Directory
    } else if file_type.is_file() {
        FileType::File
    } else if file_type.is_symlink() {
        FileType::SymbolicLink
    } else {
        FileType::Other
    }
}

fn io_error(error: std::io::Error) -> FileSystemError {
    FileSystemError::Io(error.to_string())
}

#[cfg(test)]
#[path = "local_tests.rs"]
mod tests;
