//! Directory-relative filesystem constraints, independent of operation capabilities and sandbox backends.

use globset::GlobBuilder;
use globset::GlobMatcher;
use serde::Deserialize;
use serde::Serialize;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

/// Visibility outside explicitly granted roots, consumed by process isolation owners.
#[derive(
    Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum HostReadAccess {
    #[default]
    Host,
    GrantedRoots,
}

/// Filesystem operation whose access is constrained by the profile.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PathOperation {
    Read,
    Write,
}

/// Maximum access to an exact path or subtree. Explicit denial always wins.
#[derive(
    Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum PathAccess {
    Denied,
    ReadOnly,
    #[default]
    ReadWrite,
}

/// A relative glob anchored to the directory identity that owns the grant.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PathAccessRule {
    pub pattern: String,
    pub access: PathAccess,
}

impl PathAccessRule {
    pub fn validate(&self) -> Result<(), String> {
        let path = Path::new(&self.pattern);
        if self.pattern.is_empty()
            || self.pattern.len() > 4096
            || path.is_absolute()
            || self.pattern.contains(['\\', '\0', ':'])
            || path.components().any(|part| {
                matches!(
                    part,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err("filesystem rule must be a non-empty directory-relative pattern".into());
        }
        GlobBuilder::new(&self.pattern)
            .literal_separator(true)
            .build()
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

/// Compiled immutable constraints carried by a revocable directory grant.
#[derive(Clone, Debug)]
pub struct PathAccessPolicy {
    baseline: PathAccess,
    host_read: HostReadAccess,
    rules: Vec<(PathAccessRule, GlobMatcher)>,
    exact_files: Vec<PathBuf>,
}

impl Default for PathAccessPolicy {
    fn default() -> Self {
        Self {
            baseline: PathAccess::ReadWrite,
            host_read: HostReadAccess::Host,
            rules: Vec::new(),
            exact_files: Vec::new(),
        }
    }
}

impl PartialEq for PathAccessPolicy {
    fn eq(&self, other: &Self) -> bool {
        self.baseline == other.baseline
            && self.host_read == other.host_read
            && self.exact_files == other.exact_files
            && self
                .rules
                .iter()
                .map(|(rule, _)| rule)
                .eq(other.rules.iter().map(|(rule, _)| rule))
    }
}
impl Eq for PathAccessPolicy {}

impl PathAccessPolicy {
    /// Compiles already validated configuration intent into an immutable operation constraint.
    pub fn new(baseline: PathAccess, rules: Vec<PathAccessRule>) -> Result<Self, String> {
        let rules = rules
            .into_iter()
            .map(|rule| {
                rule.validate()?;
                let matcher = GlobBuilder::new(&rule.pattern)
                    .literal_separator(true)
                    .build()
                    .map_err(|error| error.to_string())?
                    .compile_matcher();
                Ok((rule, matcher))
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(Self {
            baseline,
            host_read: HostReadAccess::Host,
            rules,
            exact_files: Vec::new(),
        })
    }

    /// Restricts a directory proof to one relative file, including its resolved target.
    /// This ceiling cannot authorize siblings, parent listing, or a symlink to another file.
    pub fn for_exact_file(path: &Path) -> Result<Self, String> {
        if path.as_os_str().is_empty()
            || path
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err("exact file scope must be a non-empty relative file path".into());
        }
        Ok(Self {
            host_read: HostReadAccess::GrantedRoots,
            exact_files: vec![path.to_path_buf()],
            ..Self::default()
        })
    }

    pub fn with_host_read(mut self, access: HostReadAccess) -> Self {
        self.host_read = access;
        self
    }
    pub fn host_read(&self) -> HostReadAccess {
        self.host_read
    }

    pub fn baseline(&self) -> PathAccess {
        self.baseline
    }
    pub fn rules(&self) -> impl Iterator<Item = &PathAccessRule> {
        self.rules.iter().map(|(rule, _)| rule)
    }

    /// Combines independent ceilings. No caller can widen a grant's existing constraints.
    pub fn intersect(&self, other: &Self) -> Self {
        let baseline = match (self.baseline, other.baseline) {
            (PathAccess::Denied, _) | (_, PathAccess::Denied) => PathAccess::Denied,
            (PathAccess::ReadOnly, _) | (_, PathAccess::ReadOnly) => PathAccess::ReadOnly,
            (PathAccess::ReadWrite, PathAccess::ReadWrite) => PathAccess::ReadWrite,
        };
        let host_read = if self.host_read == HostReadAccess::GrantedRoots
            || other.host_read == HostReadAccess::GrantedRoots
        {
            HostReadAccess::GrantedRoots
        } else {
            HostReadAccess::Host
        };
        let mut rules = self.rules.clone();
        for rule in &other.rules {
            if !rules.iter().any(|(existing, _)| existing == &rule.0) {
                rules.push(rule.clone());
            }
        }
        let mut exact_files = self.exact_files.clone();
        for file in &other.exact_files {
            if !exact_files.contains(file) {
                exact_files.push(file.clone());
            }
        }
        Self {
            baseline,
            host_read,
            rules,
            exact_files,
        }
    }

    /// Rules constrain their whole subtree; read-only and denied ceilings cannot be overridden.
    pub fn allows(&self, relative: &Path, operation: PathOperation) -> bool {
        let permitted = |access| {
            matches!(access, PathAccess::ReadWrite)
                || operation == PathOperation::Read && access == PathAccess::ReadOnly
        };
        self.exact_files.iter().all(|file| relative == file)
            && permitted(self.baseline)
            && self.rules.iter().all(|(rule, matcher)| {
                !relative.ancestors().any(|path| matcher.is_match(path)) || permitted(rule.access)
            })
    }
}
