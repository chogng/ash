use crate::model::AlwaysOnInstruction;
use crate::model::InstructionArtifact;
use crate::model::InstructionCatalogSnapshot;
use crate::model::InstructionDiagnostic;
use crate::model::InstructionDiagnosticCode;
use crate::model::InstructionLoadPolicy;
use globset::Glob;
use serde::Deserialize;
use std::fs;
use std::io::ErrorKind;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

const DIRECTORY_INSTRUCTIONS: &str = ".ash/instructions";
const USER_INSTRUCTIONS: &str = "instructions";
const MAX_ENTRIES: usize = 128;
const MAX_FILE_BYTES: usize = 32 * 1024;
const MAX_PATTERNS: usize = 32;
const MAX_PATTERN_BYTES: usize = 256;
const ALWAYS_ON_FILES: [&str; 2] = ["AGENTS.md", "ASH.md"];

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct InstructionFrontmatter {
    name: Option<String>,
    load: String,
    #[serde(default)]
    patterns: Vec<String>,
}

/// Refreshable catalog for one Ash-owned Instruction directory.
pub struct InstructionCatalog {
    root: PathBuf,
    source_root: PathBuf,
    snapshot: Arc<InstructionCatalogSnapshot>,
}

impl InstructionCatalog {
    pub fn discover(dir_root: impl AsRef<Path>) -> Self {
        Self::from_roots(dir_root.as_ref(), DIRECTORY_INSTRUCTIONS)
    }

    /// Discovers Ash-owned Instructions directly under the selected user home.
    pub fn discover_user(home: impl AsRef<Path>) -> Self {
        Self::from_roots(home.as_ref(), USER_INSTRUCTIONS)
    }

    fn from_roots(root: &Path, relative_source: &str) -> Self {
        let root = root.to_path_buf();
        let source_root = root.join(relative_source);
        let (always_on, entries, diagnostics) = scan(&root, &source_root);
        Self {
            root,
            source_root,
            snapshot: Arc::new(InstructionCatalogSnapshot::new(1, always_on, entries, diagnostics)),
        }
    }

    pub fn snapshot(&self) -> Arc<InstructionCatalogSnapshot> {
        Arc::clone(&self.snapshot)
    }

    pub fn refresh(&mut self) -> Arc<InstructionCatalogSnapshot> {
        let (always_on, entries, diagnostics) = scan(&self.root, &self.source_root);
        if self.snapshot.always_on() == always_on
            && self.snapshot.entries() == entries
            && self.snapshot.diagnostics() == diagnostics
        {
            return Arc::clone(&self.snapshot);
        }
        self.snapshot = Arc::new(InstructionCatalogSnapshot::new(
            self.snapshot
                .generation()
                .checked_add(1)
                .expect("Instruction catalog generation overflowed"),
            always_on,
            entries,
            diagnostics,
        ));
        Arc::clone(&self.snapshot)
    }
}

fn scan(
    root: &Path,
    source_root: &Path,
) -> (
    Vec<AlwaysOnInstruction>,
    Vec<InstructionArtifact>,
    Vec<InstructionDiagnostic>,
) {
    let mut diagnostics = Vec::new();
    let always_on = ALWAYS_ON_FILES
        .into_iter()
        .filter_map(|name| load_always_on(root, name, &mut diagnostics))
        .collect::<Vec<_>>();
    let metadata = match fs::symlink_metadata(source_root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return (always_on, Vec::new(), diagnostics);
        }
        Err(_) => {
            diagnostics.push(diagnostic(
                    None,
                    InstructionDiagnosticCode::SourceUnavailable,
                    "Instruction directory metadata is unavailable",
            ));
            return (always_on, Vec::new(), diagnostics);
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        diagnostics.push(diagnostic(
                None,
                InstructionDiagnosticCode::SourceUnavailable,
                "Instruction path must be a real directory",
        ));
        return (always_on, Vec::new(), diagnostics);
    }
    let mut paths = match fs::read_dir(&source_root) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .collect::<Vec<_>>(),
        Err(_) => {
            diagnostics.push(diagnostic(
                    None,
                    InstructionDiagnosticCode::SourceUnavailable,
                    "Instruction directory cannot be read",
            ));
            return (always_on, Vec::new(), diagnostics);
        }
    };
    paths.sort();
    if paths.len() > MAX_ENTRIES {
        diagnostics.push(diagnostic(
            None,
            InstructionDiagnosticCode::EntryLimitExceeded,
            format!("only the first {MAX_ENTRIES} Instruction entries are inspected"),
        ));
        paths.truncate(MAX_ENTRIES);
    }
    let mut entries = paths
        .into_iter()
        .filter_map(|path| load_entry(&source_root, &path, &mut diagnostics))
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left.name().cmp(right.name()));
    diagnostics.sort_by(|left, right| {
        (left.relative_path(), left.code(), left.message()).cmp(&(
            right.relative_path(),
            right.code(),
            right.message(),
        ))
    });
    (always_on, entries, diagnostics)
}

fn load_always_on(
    root: &Path,
    name: &'static str,
    diagnostics: &mut Vec<InstructionDiagnostic>,
) -> Option<AlwaysOnInstruction> {
    let path = root.join(name);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return None,
        Err(_) => {
            diagnostics.push(diagnostic(
                Some(PathBuf::from(name)),
                InstructionDiagnosticCode::SourceUnavailable,
                "always-on Instruction metadata is unavailable",
            ));
            return None;
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        diagnostics.push(diagnostic(
            Some(PathBuf::from(name)),
            InstructionDiagnosticCode::SourceUnavailable,
            "always-on Instruction must be a regular file",
        ));
        return None;
    }
    if metadata.len() > MAX_FILE_BYTES as u64 {
        diagnostics.push(diagnostic(
            Some(PathBuf::from(name)),
            InstructionDiagnosticCode::ContentTooLarge,
            format!("Instruction content exceeds {MAX_FILE_BYTES} bytes"),
        ));
        return None;
    }
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(_) => {
            diagnostics.push(diagnostic(
                Some(PathBuf::from(name)),
                InstructionDiagnosticCode::SourceUnavailable,
                "always-on Instruction cannot be read",
            ));
            return None;
        }
    };
    if bytes.len() > MAX_FILE_BYTES {
        diagnostics.push(diagnostic(
            Some(PathBuf::from(name)),
            InstructionDiagnosticCode::ContentTooLarge,
            format!("Instruction content exceeds {MAX_FILE_BYTES} bytes"),
        ));
        return None;
    }
    let body = match String::from_utf8(bytes) {
        Ok(body) => body.trim().to_owned(),
        Err(_) => {
            diagnostics.push(diagnostic(
                Some(PathBuf::from(name)),
                InstructionDiagnosticCode::ContentInvalidUtf8,
                "always-on Instruction must be UTF-8",
            ));
            return None;
        }
    };
    (!body.is_empty()).then_some(AlwaysOnInstruction { source: name, body })
}

fn load_entry(
    source_root: &Path,
    path: &Path,
    diagnostics: &mut Vec<InstructionDiagnostic>,
) -> Option<InstructionArtifact> {
    let relative_path = path.strip_prefix(source_root).ok()?.to_path_buf();
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => {
            diagnostics.push(diagnostic(
                Some(relative_path),
                InstructionDiagnosticCode::SourceUnavailable,
                "Instruction entry metadata is unavailable",
            ));
            return None;
        }
    };
    if metadata.file_type().is_symlink() {
        diagnostics.push(diagnostic(
            Some(relative_path),
            InstructionDiagnosticCode::SymlinkNotAllowed,
            "Instruction entries cannot be symbolic links",
        ));
        return None;
    }
    if !metadata.is_file() || path.extension().and_then(|value| value.to_str()) != Some("md") {
        diagnostics.push(diagnostic(
            Some(relative_path),
            InstructionDiagnosticCode::UnsupportedFileType,
            "Instruction entries must be direct .md files",
        ));
        return None;
    }
    let file_name = path.file_stem()?.to_str()?;
    if !valid_name(file_name) {
        diagnostics.push(diagnostic(
            Some(relative_path),
            InstructionDiagnosticCode::InvalidName,
            "Instruction filename must use lowercase letters, digits, and hyphens",
        ));
        return None;
    }
    if metadata.len() > MAX_FILE_BYTES as u64 {
        diagnostics.push(diagnostic(
            Some(relative_path),
            InstructionDiagnosticCode::ContentTooLarge,
            format!("Instruction content exceeds {MAX_FILE_BYTES} bytes"),
        ));
        return None;
    }
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => {
            diagnostics.push(diagnostic(
                Some(relative_path),
                InstructionDiagnosticCode::SourceUnavailable,
                "Instruction content cannot be read",
            ));
            return None;
        }
    };
    let text = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(_) => {
            diagnostics.push(diagnostic(
                Some(relative_path),
                InstructionDiagnosticCode::ContentInvalidUtf8,
                "Instruction content must be UTF-8",
            ));
            return None;
        }
    };
    let (frontmatter, body) = match split_frontmatter(&text) {
        Some(parts) => parts,
        None => {
            diagnostics.push(diagnostic(
                Some(relative_path),
                InstructionDiagnosticCode::InvalidFrontmatter,
                "Instruction file must start with YAML frontmatter",
            ));
            return None;
        }
    };
    let frontmatter: InstructionFrontmatter = match serde_yaml::from_str(frontmatter) {
        Ok(frontmatter) => frontmatter,
        Err(_) => {
            diagnostics.push(diagnostic(
                Some(relative_path),
                InstructionDiagnosticCode::InvalidFrontmatter,
                "Instruction frontmatter is invalid",
            ));
            return None;
        }
    };
    if frontmatter
        .name
        .as_deref()
        .is_some_and(|name| name != file_name)
    {
        diagnostics.push(diagnostic(
            Some(relative_path),
            InstructionDiagnosticCode::InvalidName,
            "Instruction frontmatter name must match the filename",
        ));
        return None;
    }
    let load_policy = match load_policy(frontmatter.load, frontmatter.patterns) {
        Ok(policy) => policy,
        Err(message) => {
            diagnostics.push(diagnostic(
                Some(relative_path),
                InstructionDiagnosticCode::InvalidLoadPolicy,
                message,
            ));
            return None;
        }
    };
    let body = body.trim().to_owned();
    if body.is_empty() {
        diagnostics.push(diagnostic(
            Some(relative_path),
            InstructionDiagnosticCode::EmptyBody,
            "Instruction body cannot be empty",
        ));
        return None;
    }
    Some(InstructionArtifact::new(
        file_name.to_owned(),
        relative_path,
        load_policy,
        body,
    ))
}

fn load_policy(load: String, patterns: Vec<String>) -> Result<InstructionLoadPolicy, &'static str> {
    if patterns.len() > MAX_PATTERNS {
        return Err("Instruction pattern count exceeds 32");
    }
    if patterns.iter().any(|pattern| {
        pattern.trim().is_empty()
            || pattern.len() > MAX_PATTERN_BYTES
            || Path::new(pattern).is_absolute()
            || Path::new(pattern)
                .components()
                .any(|component| component == std::path::Component::ParentDir)
            || Glob::new(pattern).is_err()
    }) {
        return Err("Instruction patterns must be valid relative globs");
    }
    match load.as_str() {
        "global" if patterns.is_empty() => Ok(InstructionLoadPolicy::Global),
        "contextual" if !patterns.is_empty() => Ok(InstructionLoadPolicy::Contextual { patterns }),
        "on-demand" if patterns.is_empty() => Ok(InstructionLoadPolicy::OnDemand),
        "global" | "on-demand" => Err("only contextual Instructions can declare patterns"),
        "contextual" => Err("contextual Instructions require at least one pattern"),
        _ => Err("Instruction load must be global, contextual, or on-demand"),
    }
}

fn split_frontmatter(text: &str) -> Option<(&str, &str)> {
    let rest = text.strip_prefix("---\n")?;
    let boundary = rest.find("\n---\n")?;
    Some((&rest[..boundary], &rest[boundary + 5..]))
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('-')
        && !name.ends_with('-')
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn diagnostic(
    relative_path: Option<PathBuf>,
    code: InstructionDiagnosticCode,
    message: impl Into<String>,
) -> InstructionDiagnostic {
    InstructionDiagnostic::new(relative_path, code, message)
}

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;
