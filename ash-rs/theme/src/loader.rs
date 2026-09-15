use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;

use crate::ColorScheme;
use crate::ThemeCatalog;
use crate::ThemeDocument;
use crate::ThemeSnapshot;
use thiserror::Error;

const MAX_THEME_FILES: usize = 128;
const MAX_THEME_DOCUMENT_BYTES: u64 = 1_048_576;

/// Resolves the host-local UI preference root without consulting Agent configuration.
pub fn default_device_root() -> std::io::Result<PathBuf> {
    match std::env::var_os("ASH_DEVICE_ROOT") {
        Some(root) => ash_utils_home_dir::resolve_path(Path::new(&root)),
        None => ash_utils_home_dir::find_ash_home(),
    }
}

/// Named inputs for loading the selected graphical theme.
#[derive(Clone, Copy)]
pub struct ThemeLoadOptions<'a> {
    pub device_root: &'a Path,
    pub system_scheme: ColorScheme,
    pub default_entry: &'a str,
}

impl<'a> ThemeLoadOptions<'a> {
    pub const fn new(device_root: &'a Path, system_scheme: ColorScheme) -> Self {
        Self {
            device_root,
            system_scheme,
            default_entry: "ash",
        }
    }

    /// Selects the built-in entry used when the device preference follows the system.
    pub const fn with_default_entry(mut self, default_entry: &'a str) -> Self {
        self.default_entry = default_entry;
        self
    }
}

/// One isolated theme-loading diagnostic that does not invalidate other files.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ThemeDiagnostic {
    pub file: Option<PathBuf>,
    pub message: String,
}

/// Selected snapshot plus non-fatal discovery and parsing diagnostics.
#[derive(Debug)]
pub struct LoadedTheme {
    pub snapshot: ThemeSnapshot,
    pub diagnostics: Vec<ThemeDiagnostic>,
    pub follows_system: bool,
}

/// Failure to resolve a Rust GUI theme selection.
#[derive(Debug, Error)]
pub enum ThemeSelectionError {
    #[error("invalid theme preference '{0}'")]
    InvalidPreference(String),
    #[error("theme '{0}' is unavailable")]
    Unavailable(String),
    #[error("theme '{preference}' is invalid: {source}")]
    InvalidTheme {
        preference: String,
        #[source]
        source: crate::ThemeError,
    },
}

/// Bounded loader for Rust GUI user themes; the GUI owns the selected preference.
pub struct ThemeLoader {
    catalog: ThemeCatalog,
}

impl ThemeLoader {
    pub fn embedded() -> Result<Self, crate::ThemeError> {
        Ok(Self {
            catalog: ThemeCatalog::embedded()?,
        })
    }

    /// Resolves one theme preference without changing the device configuration.
    pub fn preview(
        &self,
        options: ThemeLoadOptions<'_>,
        preference: &str,
    ) -> Result<LoadedTheme, ThemeSelectionError> {
        if preference != "system" && !crate::document::valid_theme_id(preference) {
            return Err(ThemeSelectionError::InvalidPreference(
                preference.to_owned(),
            ));
        }
        let mut diagnostics = Vec::new();
        let (snapshot, follows_system) =
            self.resolve_preference(&options, preference, &mut diagnostics)?;
        Ok(LoadedTheme {
            snapshot,
            diagnostics,
            follows_system,
        })
    }

    fn resolve_preference(
        &self,
        options: &ThemeLoadOptions<'_>,
        preference: &str,
        diagnostics: &mut Vec<ThemeDiagnostic>,
    ) -> Result<(ThemeSnapshot, bool), ThemeSelectionError> {
        if preference == "system" {
            return Ok((self.default_snapshot(options, diagnostics), true));
        }
        if let Some(snapshot) = self
            .catalog
            .resolve_built_in_id(preference)
            .expect("embedded theme entries must resolve named light and dark variants")
        {
            return Ok((snapshot, false));
        }
        let documents = read_theme_documents(options.device_root, &self.catalog, diagnostics);
        let document = documents
            .get(preference)
            .ok_or_else(|| ThemeSelectionError::Unavailable(preference.to_owned()))?;
        self.catalog
            .resolve_document(document)
            .map(|snapshot| (snapshot, false))
            .map_err(|source| ThemeSelectionError::InvalidTheme {
                preference: preference.to_owned(),
                source,
            })
    }

    fn default_snapshot(
        &self,
        options: &ThemeLoadOptions<'_>,
        diagnostics: &mut Vec<ThemeDiagnostic>,
    ) -> ThemeSnapshot {
        match self
            .catalog
            .built_in_entry(options.default_entry, options.system_scheme)
        {
            Ok(snapshot) => snapshot,
            Err(error) => {
                diagnostics.push(ThemeDiagnostic {
                    file: None,
                    message: format!(
                        "default theme entry '{}' is unavailable: {error}; using ash",
                        options.default_entry
                    ),
                });
                self.catalog
                    .built_in(options.system_scheme)
                    .expect("embedded theme catalog must resolve the ash entry")
            }
        }
    }
}

fn read_theme_documents(
    device_root: &Path,
    catalog: &ThemeCatalog,
    diagnostics: &mut Vec<ThemeDiagnostic>,
) -> BTreeMap<String, ThemeDocument> {
    let directory = device_root.join("app").join("themes");
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return BTreeMap::new(),
        Err(error) => {
            diagnostics.push(ThemeDiagnostic {
                file: Some(directory),
                message: format!("could not read user theme directory: {error}"),
            });
            return BTreeMap::new();
        }
    };
    let mut files = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            (file_type.is_file()
                && entry
                    .path()
                    .extension()
                    .and_then(|extension| extension.to_str())
                    == Some("json"))
            .then(|| entry.path())
        })
        .collect::<Vec<_>>();
    files.sort();
    files.truncate(MAX_THEME_FILES);
    let mut documents = BTreeMap::new();
    for path in files {
        let source = match read_bounded_text(&path) {
            Ok(source) => source,
            Err(error) => {
                diagnostics.push(ThemeDiagnostic {
                    file: Some(path),
                    message: format!("could not read user theme: {error}"),
                });
                continue;
            }
        };
        let document = match ThemeDocument::parse(&source) {
            Ok(document) => document,
            Err(error) => {
                diagnostics.push(ThemeDiagnostic {
                    file: Some(path),
                    message: format!("user theme is invalid: {error}"),
                });
                continue;
            }
        };
        if catalog.is_reserved_theme_id(document.id()) || documents.contains_key(document.id()) {
            diagnostics.push(ThemeDiagnostic {
                file: Some(path),
                message: format!("duplicate or reserved user theme id '{}'", document.id()),
            });
            continue;
        }
        documents.insert(document.id().to_owned(), document);
    }
    documents
}

fn read_bounded_text(path: &Path) -> std::io::Result<String> {
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(MAX_THEME_DOCUMENT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_THEME_DOCUMENT_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "document exceeds the 1 MiB limit",
        ));
    }
    String::from_utf8(bytes)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
}
