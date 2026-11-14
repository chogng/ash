//! Native Markdown document creation. The catalog owns references; files own content.

mod completed_document;

use ash_artifact_catalog::ArtifactCatalogError;
use ash_artifact_catalog::ArtifactRegistration;
use ash_artifact_catalog::ArtifactRegistrationOutcome;
use ash_artifact_catalog::ArtifactSource;
use ash_artifact_catalog::SqliteArtifactCatalog;
use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::Permission;
use ash_file_access::Permissions;
use ash_file_system::ExactFileSystem;
use ash_file_system::FileSystem;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::Turn;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

/// Accepts native Docs output once and exposes only published files to browser hosts.
pub struct Documents {
    catalog: Arc<SqliteArtifactCatalog>,
    directory: PathBuf,
}

impl Documents {
    pub fn new(catalog: Arc<SqliteArtifactCatalog>, directory: PathBuf) -> Self {
        Self { catalog, directory }
    }

    /// The final-reply adapter is a compatibility input to Docs, not Thread storage policy.
    pub fn accept_completed_turn(
        &self,
        session: &SessionId,
        thread: &ThreadId,
        turn: &Turn,
    ) -> Result<bool, ArtifactCatalogError> {
        let Some(document) = completed_document::completed_document(session, thread, turn) else {
            return Ok(false);
        };
        self.create(
            &document.id,
            &document.title,
            &document.markdown,
            ArtifactSource {
                provider_id: "local-agent-host".into(),
                account_id: None,
                session_id: session.to_string(),
                thread_id: thread.to_string(),
                item_id: document.item_id.to_string(),
                part_id: "markdown".into(),
            },
        )
    }

    fn create(
        &self,
        id: &str,
        title: &str,
        markdown: &str,
        source: ArtifactSource,
    ) -> Result<bool, ArtifactCatalogError> {
        std::fs::create_dir_all(&self.directory).map_err(storage_error)?;
        self.open_directory().map_err(storage_error)?;
        let name = format!("{id}.md");
        // Preserve both pre-registration crash recovery and edits made after publication.
        ash_utils_path::ensure_file_atomically(&self.directory.join(&name), markdown.as_bytes())
            .map_err(storage_error)?;
        let outcome = self.catalog.register_native(&ArtifactRegistration {
            id: id.into(),
            resource: format!("ash-userdata:/user/documents/{name}"),
            title: title.into(),
            content_type: "text/markdown".into(),
            source,
        })?;
        Ok(matches!(outcome, ArtifactRegistrationOutcome::Created(_)))
    }

    pub fn file_path(&self, id: &str) -> Option<PathBuf> {
        let file = self.catalog.native_resource(id).ok()??.file;
        (file.content_type == "text/markdown"
            && file.source.provider_id == "local-agent-host"
            && file.source.part_id == "markdown"
            && file.resource == format!("ash-userdata:/user/documents/{id}.md"))
        .then(|| self.directory.join(format!("{id}.md")))
    }

    pub fn resource_id<'a>(&self, path: &'a Path) -> Option<&'a str> {
        if path.parent()? != self.directory {
            return None;
        }
        let id = path.file_name()?.to_str()?.strip_suffix(".md")?;
        self.file_path(id)?;
        Some(id)
    }

    pub fn file_system(&self, id: &str) -> std::io::Result<Arc<dyn FileSystem>> {
        let path = self.file_path(id).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "document is not published",
            )
        })?;
        let grant = Grant::for_environment(
            self.open_directory()?,
            GrantSource::HostConfiguration,
            Permissions::new([
                Permission::BrowseFiles,
                Permission::ReadFiles,
                Permission::WriteFiles,
            ]),
        );
        let files = ExactFileSystem::new(
            grant,
            Path::new(path.file_name().expect("published file name")),
        )
        .map_err(std::io::Error::other)?;
        Ok(Arc::new(files))
    }

    fn open_directory(&self) -> std::io::Result<Dir> {
        let dir = Dir::open_local(&self.directory).map_err(std::io::Error::other)?;
        if dir.canonical_path() != self.directory {
            return Err(std::io::Error::other(
                "document directory resolves outside its profile path",
            ));
        }
        Ok(dir)
    }
}

fn storage_error(error: impl std::fmt::Display) -> ArtifactCatalogError {
    ArtifactCatalogError::Storage(error.to_string())
}

#[cfg(test)]
mod tests;
