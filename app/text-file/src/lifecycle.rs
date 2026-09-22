use std::path::{Path, PathBuf};

/// Whether the filesystem snapshot authorizations the host to persist new text.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TextFileAccess {
    Writable,
    ReadOnly,
}

/// Modification timestamp availability in filesystem metadata.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TextFileModifiedAt {
    KnownMillis(u64),
    Unavailable,
}

impl From<Option<u64>> for TextFileModifiedAt {
    fn from(value: Option<u64>) -> Self {
        value.map_or(Self::Unavailable, Self::KnownMillis)
    }
}

/// Filesystem metadata retained as an optimistic-concurrency save precondition.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TextFileDiskVersion {
    size_bytes: u64,
    modified_at: TextFileModifiedAt,
    access: TextFileAccess,
}

impl TextFileDiskVersion {
    /// Creates the disk version observed alongside a file read.
    pub const fn new(
        size_bytes: u64,
        modified_at: TextFileModifiedAt,
        access: TextFileAccess,
    ) -> Self {
        Self {
            size_bytes,
            modified_at,
            access,
        }
    }

    pub const fn size_bytes(self) -> u64 {
        self.size_bytes
    }

    pub const fn modified_at(self) -> TextFileModifiedAt {
        self.modified_at
    }

    pub const fn access(self) -> TextFileAccess {
        self.access
    }

    pub const fn is_read_only(self) -> bool {
        matches!(self.access, TextFileAccess::ReadOnly)
    }
}

/// One authoritative UTF-8 snapshot loaded through a directory filesystem capability.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TextFileSnapshot {
    path: PathBuf,
    content: String,
    version: TextFileDiskVersion,
}

impl TextFileSnapshot {
    /// Binds text and disk metadata captured by the same logical read operation.
    pub fn new(path: PathBuf, content: String, version: TextFileDiskVersion) -> Self {
        Self {
            path,
            content,
            version,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn content(&self) -> &str {
        &self.content
    }

    pub const fn version(&self) -> TextFileDiskVersion {
        self.version
    }
}

/// Product-visible relationship between current editor text and filesystem state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TextFileStatus {
    Clean,
    Dirty,
    ReloadAvailable,
    Conflict,
}

/// Outcome of reconciling a new snapshot with one retained lifecycle.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TextFileObserveResult {
    Synchronized,
    ReloadAvailable,
    PathMismatch,
}

/// Immutable payload passed to a filesystem adapter for an optimistic save.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TextFileSaveRequest {
    path: PathBuf,
    content: String,
    expected_version: TextFileDiskVersion,
}

impl TextFileSaveRequest {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn content(&self) -> &str {
        &self.content
    }

    pub const fn expected_version(&self) -> TextFileDiskVersion {
        self.expected_version
    }

    /// Consumes the request into the values needed by a filesystem adapter.
    pub fn into_parts(self) -> (PathBuf, String, TextFileDiskVersion) {
        (self.path, self.content, self.expected_version)
    }
}

/// Saved baseline, disk precondition, and pending external snapshot for one UTF-8 file.
///
/// Hosts keep their mutable editor document separately and pass its current text to this type.
/// This lets any editor implementation reuse the lifecycle without making the file domain depend
/// on editor state, filesystem transport, or rendering.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TextFileLifecycle {
    path: PathBuf,
    saved_text: String,
    disk_version: TextFileDiskVersion,
    pending_external: Option<TextFileSnapshot>,
}

impl TextFileLifecycle {
    /// Creates a clean lifecycle from the snapshot used to initialize an editor document.
    pub fn new(snapshot: TextFileSnapshot) -> Self {
        Self {
            path: snapshot.path,
            saved_text: snapshot.content,
            disk_version: snapshot.version,
            pending_external: None,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn is_dirty(&self, current_text: &str) -> bool {
        current_text != self.saved_text
    }

    pub const fn is_read_only(&self) -> bool {
        self.disk_version.is_read_only()
    }

    pub fn status(&self, current_text: &str) -> TextFileStatus {
        match (self.is_dirty(current_text), self.pending_external.is_some()) {
            (false, false) => TextFileStatus::Clean,
            (true, false) => TextFileStatus::Dirty,
            (false, true) => TextFileStatus::ReloadAvailable,
            (true, true) => TextFileStatus::Conflict,
        }
    }

    /// Builds a save request only when the text is dirty and the last disk snapshot was writable.
    pub fn save_request(&self, current_text: &str) -> Option<TextFileSaveRequest> {
        (self.is_dirty(current_text) && !self.is_read_only()).then(|| TextFileSaveRequest {
            path: self.path.clone(),
            content: current_text.to_owned(),
            expected_version: self.disk_version,
        })
    }

    /// Builds an explicit optimistic overwrite after both the editor and disk changed.
    ///
    /// The request uses the pending external snapshot as its precondition, so a second disk change
    /// still prevents the write. Hosts must only call this after the user chooses to keep the
    /// editor text; ordinary saves continue to use [`Self::save_request`].
    pub fn overwrite_request(&self, current_text: &str) -> Option<TextFileSaveRequest> {
        let pending = self.pending_external.as_ref()?;
        (self.is_dirty(current_text) && !pending.version.is_read_only()).then(|| {
            TextFileSaveRequest {
                path: self.path.clone(),
                content: current_text.to_owned(),
                expected_version: pending.version,
            }
        })
    }

    /// Advances the saved baseline after the filesystem adapter has completed a write.
    pub fn mark_saved(&mut self, current_text: &str, version: TextFileDiskVersion) {
        self.saved_text = current_text.to_owned();
        self.disk_version = version;
        self.pending_external = None;
    }

    /// Reconciles a newly read snapshot without overwriting editor-owned current text.
    pub fn observe_external(
        &mut self,
        current_text: &str,
        snapshot: TextFileSnapshot,
    ) -> TextFileObserveResult {
        if snapshot.path != self.path {
            return TextFileObserveResult::PathMismatch;
        }
        if snapshot.content == current_text {
            self.saved_text = snapshot.content;
            self.disk_version = snapshot.version;
            self.pending_external = None;
            TextFileObserveResult::Synchronized
        } else {
            self.pending_external = Some(snapshot);
            TextFileObserveResult::ReloadAvailable
        }
    }

    /// Removes and returns the pending external snapshot selected by the host for reload.
    pub fn take_pending_external(&mut self) -> Option<TextFileSnapshot> {
        self.pending_external.take()
    }
}

#[cfg(test)]
#[path = "lifecycle_tests.rs"]
mod tests;
