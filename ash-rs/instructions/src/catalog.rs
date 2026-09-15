use crate::model::AlwaysOnInstruction;
use crate::model::InstructionArtifact;
use crate::model::InstructionCatalogSnapshot;
use crate::model::InstructionDiagnostic;
use crate::model::InstructionDiagnosticCode;
use crate::model::InstructionLoadPolicy;
use globset::Glob;
use serde::Deserialize;
use std::collections::BTreeSet;
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
const MAX_NESTED_DIRS: usize = 64;
const MAX_NESTED_DEPTH: usize = 16;

/// Rules found along the paths of files this Agent has actually read.
#[derive(Default)]
pub struct NestedInstructions {
    files: Vec<PathBuf>,
    entries: Vec<AlwaysOnInstruction>,
    content: Option<String>,
    diagnostics: Vec<InstructionDiagnostic>,
}

impl NestedInstructions {
    /// Selected nested files retain their individual bodies and relative source paths.
    pub fn entries(&self) -> impl Iterator<Item = (&Path, &str)> {
        self.entries
            .iter()
            .map(|entry| (entry.source.as_path(), entry.body.as_str()))
    }

    pub fn content(&self) -> Option<&str> {
        self.content.as_deref()
    }

    pub fn diagnostics(&self) -> &[InstructionDiagnostic] {
        &self.diagnostics
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct InstructionFrontmatter {
    name: Option<String>,
    description: Option<String>,
    load: String,
    #[serde(default)]
    patterns: Vec<String>,
}

/// Refreshable catalog for one Ash-owned Instruction directory.
pub struct InstructionCatalog {
    root: PathBuf,
    source_root: PathBuf,
    nested: bool,
    snapshot: Arc<InstructionCatalogSnapshot>,
}

impl InstructionCatalog {
    pub fn discover(dir_root: impl AsRef<Path>) -> Self {
        Self::from_roots(dir_root.as_ref(), DIRECTORY_INSTRUCTIONS, true)
    }

    /// Discovers Ash-owned Instructions directly under the selected user home.
    pub fn discover_user(home: impl AsRef<Path>) -> Self {
        Self::from_roots(home.as_ref(), USER_INSTRUCTIONS, false)
    }

    fn from_roots(root: &Path, relative_source: &str, nested: bool) -> Self {
        let root = root.to_path_buf();
        let source_root = root.join(relative_source);
        let (always_on, entries, diagnostics) = scan(&root, &source_root);
        Self {
            root,
            source_root,
            nested,
            snapshot: Arc::new(InstructionCatalogSnapshot::new(
                1,
                always_on,
                entries,
                diagnostics,
            )),
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

    /// Reads a discovered rule or an in-scope nested AGENTS.md/ASH.md file.
    pub fn read(&self, path: &Path) -> Option<String> {
        if let Some(body) = self.snapshot.body_at(path, &self.root, &self.source_root) {
            return Some(body.to_owned());
        }
        let relative = path.strip_prefix(&self.root).ok()?;
        if !self.nested
            || !relative
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| ALWAYS_ON_FILES.contains(&name))
            || relative.components().count() > MAX_NESTED_DEPTH + 1
            || relative.components().any(|part| {
                matches!(
                    part,
                    std::path::Component::ParentDir | std::path::Component::CurDir
                )
            })
        {
            return None;
        }
        let root = fs::canonicalize(&self.root).ok()?;
        if !fs::canonicalize(path.parent()?).ok()?.starts_with(root) {
            return None;
        }
        load_always_on(&self.root, relative, &mut Vec::new()).map(|entry| entry.body)
    }

    /// Lists applicable rules that must be read before changing the target paths.
    /// Both path sets are relative to this catalog's authorized directory.
    pub fn required_reads(
        &self,
        targets: &[PathBuf],
        known: &[PathBuf],
        selected: &[PathBuf],
    ) -> Vec<PathBuf> {
        let mut required = BTreeSet::new();
        for entry in self.snapshot.entries() {
            if !matches!(
                entry.load_policy(),
                InstructionLoadPolicy::Contextual { .. }
            ) {
                continue;
            }
            let file = self.source_root.join(entry.relative_path());
            let read = selected.contains(&file);
            if entry.applies_to(targets) && !entry.applies_to(known) && !read {
                required.insert(file);
            }
        }
        let known_nested = self.nested_instructions(known);
        let target_nested = self.nested_instructions(targets);
        for path in target_nested.files {
            if !known_nested.files.contains(&path) && !selected.contains(&self.root.join(&path)) {
                required.insert(self.root.join(path));
            }
        }
        required.into_iter().collect()
    }

    /// Reads nested always-on files only below confirmed file paths in this directory.
    pub fn nested_instructions(&self, paths: &[PathBuf]) -> NestedInstructions {
        if !self.nested || paths.is_empty() {
            return NestedInstructions::default();
        }
        let mut diagnostics = Vec::new();
        let mut dirs = BTreeSet::new();
        for path in paths {
            if path.is_absolute()
                || path.components().any(|component| {
                    matches!(
                        component,
                        std::path::Component::CurDir
                            | std::path::Component::ParentDir
                            | std::path::Component::Prefix(_)
                    )
                })
            {
                continue;
            }
            let mut depth_reported = false;
            for ancestor in path.parent().into_iter().flat_map(Path::ancestors) {
                if ancestor.as_os_str().is_empty() {
                    break;
                }
                if ancestor.components().count() > MAX_NESTED_DEPTH {
                    if !depth_reported {
                        diagnostics.push(diagnostic(
                            Some(ancestor.to_path_buf()),
                            InstructionDiagnosticCode::EntryLimitExceeded,
                            "nested Instruction depth exceeds 16 directories",
                        ));
                        depth_reported = true;
                    }
                    continue;
                }
                dirs.insert(ancestor.to_path_buf());
            }
        }
        let mut dirs = dirs.into_iter().collect::<Vec<_>>();
        dirs.sort_by(|left, right| {
            left.components()
                .count()
                .cmp(&right.components().count())
                .then(left.cmp(right))
        });
        if dirs.len() > MAX_NESTED_DIRS {
            dirs.truncate(MAX_NESTED_DIRS);
            diagnostics.push(diagnostic(
                None,
                InstructionDiagnosticCode::EntryLimitExceeded,
                "only the first 64 nested Instruction directories are inspected",
            ));
        }
        let Ok(canonical_root) = fs::canonicalize(&self.root) else {
            diagnostics.push(diagnostic(
                None,
                InstructionDiagnosticCode::SourceUnavailable,
                "Instruction root cannot be resolved",
            ));
            return NestedInstructions {
                files: Vec::new(),
                entries: Vec::new(),
                content: None,
                diagnostics,
            };
        };
        let mut loaded = Vec::new();
        let mut files = Vec::new();
        let mut entries = Vec::new();
        for dir in dirs {
            let absolute_dir = self.root.join(&dir);
            if !fs::canonicalize(&absolute_dir)
                .is_ok_and(|canonical| canonical.starts_with(&canonical_root))
            {
                diagnostics.push(diagnostic(
                    Some(dir),
                    InstructionDiagnosticCode::SourceUnavailable,
                    "nested Instruction directory escapes or is unavailable",
                ));
                continue;
            }
            for name in ALWAYS_ON_FILES {
                if let Some(entry) = load_always_on(&self.root, &dir.join(name), &mut diagnostics) {
                    files.push(entry.source.clone());
                    loaded.push(entry.render());
                    entries.push(entry);
                }
            }
        }
        let content = (!loaded.is_empty()).then(|| loaded.join("\n\n"));
        NestedInstructions {
            files,
            entries,
            content,
            diagnostics,
        }
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
        .filter_map(|name| load_always_on(root, Path::new(name), &mut diagnostics))
        .collect::<Vec<_>>();
    let relative_source = source_root
        .strip_prefix(root)
        .expect("instruction source belongs to scope");
    let metadata = match fs::symlink_metadata(source_root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return (always_on, Vec::new(), diagnostics);
        }
        Err(_) => {
            diagnostics.push(diagnostic(
                Some(relative_source.to_path_buf()),
                InstructionDiagnosticCode::SourceUnavailable,
                "Instruction directory metadata is unavailable",
            ));
            return (always_on, Vec::new(), diagnostics);
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        diagnostics.push(diagnostic(
            Some(relative_source.to_path_buf()),
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
                Some(relative_source.to_path_buf()),
                InstructionDiagnosticCode::SourceUnavailable,
                "Instruction directory cannot be read",
            ));
            return (always_on, Vec::new(), diagnostics);
        }
    };
    paths.sort();
    if paths.len() > MAX_ENTRIES {
        diagnostics.push(diagnostic(
            Some(relative_source.to_path_buf()),
            InstructionDiagnosticCode::EntryLimitExceeded,
            format!("only the first {MAX_ENTRIES} Instruction entries are inspected"),
        ));
        paths.truncate(MAX_ENTRIES);
    }
    let mut entries = paths
        .into_iter()
        .filter_map(|path| {
            let mut errors = Vec::new();
            let entry = load_entry(source_root, &path, &mut errors);
            diagnostics.extend(errors.into_iter().map(|error| {
                InstructionDiagnostic::new(
                    Some(relative_source.join(error.relative_path().unwrap_or(Path::new(".")))),
                    error.code(),
                    error.message(),
                )
            }));
            entry
        })
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
    relative: &Path,
    diagnostics: &mut Vec<InstructionDiagnostic>,
) -> Option<AlwaysOnInstruction> {
    let path = root.join(relative);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return None,
        Err(_) => {
            diagnostics.push(diagnostic(
                Some(relative.to_path_buf()),
                InstructionDiagnosticCode::SourceUnavailable,
                "always-on Instruction metadata is unavailable",
            ));
            return None;
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        diagnostics.push(diagnostic(
            Some(relative.to_path_buf()),
            InstructionDiagnosticCode::SourceUnavailable,
            "always-on Instruction must be a regular file",
        ));
        return None;
    }
    if metadata.len() > MAX_FILE_BYTES as u64 {
        diagnostics.push(diagnostic(
            Some(relative.to_path_buf()),
            InstructionDiagnosticCode::ContentTooLarge,
            format!("Instruction content exceeds {MAX_FILE_BYTES} bytes"),
        ));
        return None;
    }
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(_) => {
            diagnostics.push(diagnostic(
                Some(relative.to_path_buf()),
                InstructionDiagnosticCode::SourceUnavailable,
                "always-on Instruction cannot be read",
            ));
            return None;
        }
    };
    if bytes.len() > MAX_FILE_BYTES {
        diagnostics.push(diagnostic(
            Some(relative.to_path_buf()),
            InstructionDiagnosticCode::ContentTooLarge,
            format!("Instruction content exceeds {MAX_FILE_BYTES} bytes"),
        ));
        return None;
    }
    let body = match String::from_utf8(bytes) {
        Ok(body) => body.trim().to_owned(),
        Err(_) => {
            diagnostics.push(diagnostic(
                Some(relative.to_path_buf()),
                InstructionDiagnosticCode::ContentInvalidUtf8,
                "always-on Instruction must be UTF-8",
            ));
            return None;
        }
    };
    (!body.is_empty()).then_some(AlwaysOnInstruction {
        source: relative.to_path_buf(),
        body,
    })
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
    parse_entry(relative_path, &text, diagnostics)
}

fn parse_entry(
    relative_path: PathBuf,
    text: &str,
    diagnostics: &mut Vec<InstructionDiagnostic>,
) -> Option<InstructionArtifact> {
    let file_name = relative_path.file_stem()?.to_str()?;
    let (frontmatter, body) = match split_frontmatter(text) {
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
    if frontmatter
        .description
        .as_ref()
        .is_some_and(|description| description.trim().is_empty() || description.len() > 1024)
    {
        diagnostics.push(diagnostic(
            Some(relative_path),
            InstructionDiagnosticCode::InvalidFrontmatter,
            "Instruction description must contain 1–1024 bytes",
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
        frontmatter.description,
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

/// Validates a proposed user or project instruction using the same rules as catalog discovery.
/// Only ASH.md and direct user/directory instruction entries are publishable; AGENTS.md is shared.
pub fn validate_instruction(path: &Path, text: &str) -> Result<(), &'static str> {
    if text.len() > MAX_FILE_BYTES || text.trim().is_empty() {
        return Err("Instruction must contain 1–32768 bytes");
    }
    if path == Path::new("ASH.md") {
        return Ok(());
    }
    if ![Path::new(DIRECTORY_INSTRUCTIONS), Path::new("instructions")]
        .contains(&path.parent().unwrap_or(Path::new("")))
        || path.extension().and_then(|value| value.to_str()) != Some("md")
    {
        return Err(
            "Instruction target must be ASH.md or a direct instructions/.ash/instructions Markdown file",
        );
    }
    let name = path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("Invalid instruction name")?;
    if !valid_name(name) {
        return Err("Invalid instruction name");
    }
    let mut diagnostics = Vec::new();
    parse_entry(
        PathBuf::from(path.file_name().ok_or("Invalid instruction path")?),
        text,
        &mut diagnostics,
    )
    .map(|_| ())
    .ok_or("Invalid instruction document")
}
