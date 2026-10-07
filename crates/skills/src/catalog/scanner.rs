use crate::catalog::{SkillCatalogEntry, SkillMetadata};
use crate::format::{MAX_FRONTMATTER_BYTES, parse_frontmatter};
use crate::{
    ContentDigest, SkillCompatibility, SkillDiagnostic, SkillDiagnosticCode, SkillId, SkillName,
    SkillSourceRoot,
};
use ash_file_identity::FileInformation;
use sha2::{Digest, Sha256};
use std::fs::{self, File, Metadata};
use std::io::Read;
use std::path::Path;

const MAX_SOURCE_ENTRIES: usize = 1024;
const MAX_SKILL_FILE_BYTES: u64 = 1024 * 1024;
const READ_BUFFER_BYTES: usize = 64 * 1024;

pub(super) struct CatalogProjection {
    pub(super) entries: Vec<SkillCatalogEntry>,
    pub(super) diagnostics: Vec<SkillDiagnostic>,
}

pub(super) fn scan_sources(sources: &[SkillSourceRoot]) -> CatalogProjection {
    let mut entries = Vec::new();
    let mut diagnostics = Vec::new();
    for source in sources {
        scan_source(source, &mut entries, &mut diagnostics);
    }
    entries.sort_by(|left, right| left.id().cmp(right.id()));
    diagnostics.sort();
    diagnostics.dedup();
    CatalogProjection {
        entries,
        diagnostics,
    }
}

fn scan_source(
    source: &SkillSourceRoot,
    entries: &mut Vec<SkillCatalogEntry>,
    diagnostics: &mut Vec<SkillDiagnostic>,
) {
    let root = source.host_root();
    let Ok(root_metadata) = fs::symlink_metadata(root) else {
        diagnostics.push(diagnostic(
            source,
            None,
            SkillDiagnosticCode::SourceUnavailable,
            "skill source is unavailable during scan",
        ));
        return;
    };
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        diagnostics.push(diagnostic(
            source,
            None,
            SkillDiagnosticCode::SourceUnavailable,
            "skill source is no longer a real directory",
        ));
        return;
    }

    if let Some(name) = source.exact_skill_name() {
        scan_skill(source, name, root, entries, diagnostics);
        return;
    }

    let Ok(read_directory) = fs::read_dir(root) else {
        diagnostics.push(diagnostic(
            source,
            None,
            SkillDiagnosticCode::SourceUnavailable,
            "skill source cannot be enumerated",
        ));
        return;
    };
    let mut children = Vec::new();
    for child in read_directory {
        let Ok(child) = child else {
            diagnostics.push(diagnostic(
                source,
                None,
                SkillDiagnosticCode::SourceUnavailable,
                "skill source changed or became unreadable during scan",
            ));
            return;
        };
        if children.len() == MAX_SOURCE_ENTRIES {
            diagnostics.push(diagnostic(
                source,
                None,
                SkillDiagnosticCode::SourceLimitExceeded,
                "skill source exceeds the 1024-entry discovery limit",
            ));
            return;
        }
        children.push(child);
    }
    children.sort_by_key(|entry| entry.file_name());

    for child in children {
        let path = child.path();
        let label = child
            .file_name()
            .to_str()
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| "<unsupported-name>".into());
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            diagnostics.push(diagnostic(
                source,
                Some(label),
                SkillDiagnosticCode::SourceUnavailable,
                "skill entry changed during discovery",
            ));
            continue;
        };
        if metadata.file_type().is_symlink() {
            diagnostics.push(diagnostic(
                source,
                Some(label),
                SkillDiagnosticCode::PathEscapesRoot,
                "skill entry must not be a symbolic link",
            ));
            continue;
        }
        if !metadata.is_dir() {
            if !metadata.is_file() {
                diagnostics.push(diagnostic(
                    source,
                    Some(label),
                    SkillDiagnosticCode::UnsupportedFileType,
                    "skill source entry is not a regular file or directory",
                ));
            }
            continue;
        }
        let Ok(name) = SkillName::new(label.clone()) else {
            diagnostics.push(diagnostic(
                source,
                Some(label),
                SkillDiagnosticCode::InvalidSkillName,
                "skill directory name is not a valid Agent Skills name",
            ));
            continue;
        };
        scan_skill(source, &name, &path, entries, diagnostics);
    }
}

fn scan_skill(
    source: &SkillSourceRoot,
    name: &SkillName,
    directory: &Path,
    entries: &mut Vec<SkillCatalogEntry>,
    diagnostics: &mut Vec<SkillDiagnostic>,
) {
    let subject = format!("{name}/SKILL.md");
    let Ok(canonical_directory) = directory.canonicalize() else {
        diagnostics.push(diagnostic(
            source,
            Some(name.to_string()),
            SkillDiagnosticCode::SourceUnavailable,
            "skill directory cannot be canonicalized",
        ));
        return;
    };
    if !canonical_directory.starts_with(source.host_root()) {
        diagnostics.push(diagnostic(
            source,
            Some(name.to_string()),
            SkillDiagnosticCode::PathEscapesRoot,
            "skill directory escapes its source root",
        ));
        return;
    }

    let manifest_path = directory.join("SKILL.md");
    let manifest_metadata = match fs::symlink_metadata(&manifest_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            diagnostics.push(diagnostic(
                source,
                Some(subject),
                SkillDiagnosticCode::SkillNotFound,
                "skill directory is missing SKILL.md",
            ));
            return;
        }
        Err(_) => {
            diagnostics.push(diagnostic(
                source,
                Some(subject),
                SkillDiagnosticCode::SourceUnavailable,
                "SKILL.md cannot be inspected",
            ));
            return;
        }
    };
    if manifest_metadata.file_type().is_symlink() {
        diagnostics.push(diagnostic(
            source,
            Some(subject),
            SkillDiagnosticCode::PathEscapesRoot,
            "SKILL.md must not be a symbolic link",
        ));
        return;
    }
    let manifest_information = FileInformation::from_path(&manifest_path);
    if !manifest_metadata.is_file()
        || manifest_information
            .as_ref()
            .map_or(true, |information| information.has_multiple_links())
    {
        diagnostics.push(diagnostic(
            source,
            Some(subject),
            SkillDiagnosticCode::UnsupportedFileType,
            "SKILL.md must be a single-link regular file",
        ));
        return;
    }
    if manifest_metadata.len() > MAX_SKILL_FILE_BYTES {
        diagnostics.push(diagnostic(
            source,
            Some(subject),
            SkillDiagnosticCode::ContentTooLarge,
            "SKILL.md exceeds the 1 MiB discovery limit",
        ));
        return;
    }
    let Ok(canonical_manifest) = manifest_path.canonicalize() else {
        diagnostics.push(diagnostic(
            source,
            Some(subject),
            SkillDiagnosticCode::SourceUnavailable,
            "SKILL.md cannot be canonicalized",
        ));
        return;
    };
    if !canonical_manifest.starts_with(&canonical_directory) {
        diagnostics.push(diagnostic(
            source,
            Some(subject),
            SkillDiagnosticCode::PathEscapesRoot,
            "SKILL.md escapes its Skill directory",
        ));
        return;
    }

    let scanned = match scan_skill_file(
        &manifest_path,
        &manifest_metadata,
        manifest_information
            .as_ref()
            .expect("validated file information"),
    ) {
        Ok(scanned) => scanned,
        Err(failure) => {
            diagnostics.push(diagnostic(
                source,
                Some(subject),
                failure.code,
                failure.message,
            ));
            return;
        }
    };
    let frontmatter = match parse_frontmatter(&scanned.frontmatter, name) {
        Ok(frontmatter) => frontmatter,
        Err(failure) => {
            diagnostics.push(diagnostic(
                source,
                Some(subject),
                failure.code,
                failure.message,
            ));
            return;
        }
    };
    let compatibility = frontmatter
        .compatibility
        .map(|note| SkillCompatibility::Unknown { note })
        .unwrap_or(SkillCompatibility::Compatible);
    entries.push(SkillCatalogEntry::new(
        SkillId::new(source.view().id().clone(), name.clone()),
        source.view().clone(),
        scanned.digest,
        SkillMetadata::new(
            frontmatter.description,
            frontmatter.license,
            frontmatter.metadata,
            frontmatter.allowed_tools,
        ),
        compatibility,
    ));
}

struct ScannedSkillFile {
    frontmatter: Vec<u8>,
    digest: ContentDigest,
}

struct ScanFailure {
    code: SkillDiagnosticCode,
    message: &'static str,
}

fn scan_skill_file(
    path: &Path,
    expected_metadata: &Metadata,
    expected_information: &FileInformation,
) -> Result<ScannedSkillFile, ScanFailure> {
    let mut file = File::open(path).map_err(|_| unavailable_file())?;
    let opened_information = FileInformation::from_file(&file).map_err(|_| unavailable_file())?;
    if !opened_information.same_file_as(*expected_information)
        || opened_information.has_multiple_links()
    {
        return Err(unavailable_file());
    }
    let mut hasher = Sha256::new();
    let mut frontmatter_capture = FrontmatterCapture::new();
    let mut total_bytes = 0_u64;
    let mut buffer = [0_u8; READ_BUFFER_BYTES];

    loop {
        let count = file.read(&mut buffer).map_err(|_| unavailable_file())?;
        if count == 0 {
            break;
        }
        total_bytes = total_bytes
            .checked_add(count as u64)
            .ok_or_else(content_too_large)?;
        if total_bytes > MAX_SKILL_FILE_BYTES {
            return Err(content_too_large());
        }
        hasher.update(&buffer[..count]);
        frontmatter_capture.push(&buffer[..count])?;
    }
    let frontmatter = frontmatter_capture.finish()?;

    let observed_metadata = fs::symlink_metadata(path).map_err(|_| unavailable_file())?;
    let observed_information = FileInformation::from_path(path).map_err(|_| unavailable_file())?;
    if observed_metadata.file_type().is_symlink()
        || !observed_metadata.is_file()
        || observed_information.has_multiple_links()
        || observed_metadata.len() != expected_metadata.len()
        || total_bytes != expected_metadata.len()
        || !observed_information.same_file_as(opened_information)
    {
        return Err(ScanFailure {
            code: SkillDiagnosticCode::SourceUnavailable,
            message: "SKILL.md changed during discovery",
        });
    }

    Ok(ScannedSkillFile {
        frontmatter,
        digest: ContentDigest::new(format!("sha256:{:x}", hasher.finalize()))
            .expect("SHA-256 output is a valid content digest"),
    })
}

struct FrontmatterCapture {
    first_line: bool,
    complete: bool,
    current_line: Vec<u8>,
    frontmatter: Vec<u8>,
}

impl FrontmatterCapture {
    fn new() -> Self {
        Self {
            first_line: true,
            complete: false,
            current_line: Vec::new(),
            frontmatter: Vec::with_capacity(4096),
        }
    }

    fn push(&mut self, bytes: &[u8]) -> Result<(), ScanFailure> {
        if self.complete {
            return Ok(());
        }
        for byte in bytes {
            self.current_line.push(*byte);
            if self.current_line.len() > MAX_FRONTMATTER_BYTES {
                return Err(frontmatter_too_large());
            }
            if *byte == b'\n' {
                self.finish_line()?;
                if self.complete {
                    break;
                }
            }
        }
        Ok(())
    }

    fn finish(mut self) -> Result<Vec<u8>, ScanFailure> {
        if !self.complete && !self.current_line.is_empty() {
            self.finish_line()?;
        }
        if !self.complete {
            return Err(invalid_frontmatter());
        }
        Ok(self.frontmatter)
    }

    fn finish_line(&mut self) -> Result<(), ScanFailure> {
        if self.first_line {
            if !matches!(self.current_line.as_slice(), b"---\n" | b"---\r\n") {
                return Err(invalid_frontmatter());
            }
            self.first_line = false;
            self.current_line.clear();
            return Ok(());
        }

        let line_without_newline = self
            .current_line
            .strip_suffix(b"\n")
            .unwrap_or(&self.current_line);
        let line_without_delimiter = line_without_newline
            .strip_suffix(b"\r")
            .unwrap_or(line_without_newline);
        if line_without_delimiter == b"---" {
            self.complete = true;
            self.current_line.clear();
            return Ok(());
        }
        if self.frontmatter.len() + self.current_line.len() > MAX_FRONTMATTER_BYTES {
            return Err(frontmatter_too_large());
        }
        self.frontmatter.extend_from_slice(&self.current_line);
        self.current_line.clear();
        Ok(())
    }
}

fn diagnostic(
    source: &SkillSourceRoot,
    subject: Option<String>,
    code: SkillDiagnosticCode,
    message: &'static str,
) -> SkillDiagnostic {
    SkillDiagnostic::new(source.view().id().clone(), subject, code, message)
}

fn invalid_frontmatter() -> ScanFailure {
    ScanFailure {
        code: SkillDiagnosticCode::InvalidFrontmatter,
        message: "SKILL.md must begin with bounded YAML frontmatter",
    }
}

fn frontmatter_too_large() -> ScanFailure {
    ScanFailure {
        code: SkillDiagnosticCode::ContentTooLarge,
        message: "SKILL.md frontmatter exceeds the 16 KiB discovery limit",
    }
}

fn content_too_large() -> ScanFailure {
    ScanFailure {
        code: SkillDiagnosticCode::ContentTooLarge,
        message: "SKILL.md exceeds the 1 MiB discovery limit",
    }
}

fn unavailable_file() -> ScanFailure {
    ScanFailure {
        code: SkillDiagnosticCode::SourceUnavailable,
        message: "SKILL.md cannot be read",
    }
}
