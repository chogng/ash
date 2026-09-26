//! Browser documents for complete Mermaid diagrams in assistant messages.

use super::markdown;
use sha2::Digest;
use sha2::Sha256;
use std::collections::HashMap;
use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use url::Url;

const PAGE: &str = include_str!("../../assets/mermaid_preview.html");
const MAX_SOURCE_BYTES: usize = 512 * 1024;
static NEXT_TEMP_FILE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug)]
pub(crate) struct MermaidPreviews {
    directory: PathBuf,
    seen_revisions: HashMap<String, u64>,
}

impl MermaidPreviews {
    pub(crate) fn new(profile_root: &Path) -> Self {
        Self {
            directory: profile_root.join("ash-code").join("mermaid-previews"),
            seen_revisions: HashMap::new(),
        }
    }

    pub(crate) fn prepare_message(
        &mut self,
        cell_id: &str,
        revision: u64,
        markdown_source: &str,
    ) -> Result<(), String> {
        if self.seen_revisions.get(cell_id) == Some(&revision) {
            return Ok(());
        }
        self.seen_revisions.insert(cell_id.to_owned(), revision);
        let sources = markdown::closed_mermaid_sources(markdown_source);
        for source in sources {
            if source.len() > MAX_SOURCE_BYTES || source.trim().is_empty() {
                continue;
            }
            self.write_document(&source)
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub(crate) fn reset_message_revisions(&mut self) {
        self.seen_revisions.clear();
    }

    pub(crate) fn url(&self, source: &str) -> Option<String> {
        if source.len() > MAX_SOURCE_BYTES {
            return None;
        }
        let path = self.path(source);
        is_regular_file(&path)
            .then(|| Url::from_file_path(path).ok())
            .flatten()
            .map(Into::into)
    }

    fn path(&self, source: &str) -> PathBuf {
        // A page update must create a fresh document for existing conversation content.
        let mut digest = Sha256::new();
        digest.update(PAGE.as_bytes());
        digest.update(source.as_bytes());
        let digest = digest.finalize();
        self.directory.join(format!("{digest:x}.html"))
    }

    fn write_document(&self, source: &str) -> std::io::Result<()> {
        let path = self.path(source);
        if is_regular_file(&path) {
            return Ok(());
        }
        fs::create_dir_all(&self.directory)?;
        let name = format!(
            ".{}-{}-{}.tmp",
            path.file_stem().unwrap_or_default().to_string_lossy(),
            std::process::id(),
            NEXT_TEMP_FILE.fetch_add(1, Ordering::Relaxed)
        );
        let temporary_path = self.directory.join(name);
        let write_result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary_path)?;
            let escaped = escape_html(source);
            let document = PAGE.replace("<!--MERMAID_SOURCE-->", &escaped);
            file.write_all(document.as_bytes())?;
            file.sync_all()?;
            fs::rename(&temporary_path, &path)
        })();
        if write_result.is_err() {
            let _ = fs::remove_file(&temporary_path);
        }
        write_result
    }
}

fn is_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_file())
}

fn escape_html(source: &str) -> String {
    source
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

#[cfg(test)]
#[path = "mermaid_preview_tests.rs"]
mod tests;
