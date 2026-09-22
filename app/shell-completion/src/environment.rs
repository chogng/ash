use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::path::PathBuf;

const MAX_PATH_ENTRIES: usize = 256;
const MAX_EXECUTABLES: usize = 16_384;

#[derive(Clone, Debug, Default)]
pub(crate) struct ExecutableCatalog {
    path_entries: Vec<PathBuf>,
    executables: BTreeMap<String, PathBuf>,
}

impl ExecutableCatalog {
    pub(crate) fn from_process_path() -> Self {
        let process_path = std::env::var_os("PATH");
        let entries = process_path
            .as_deref()
            .map(std::env::split_paths)
            .into_iter()
            .flatten();
        Self::from_path_entries(entries)
    }

    pub(crate) fn from_path_entries(entries: impl IntoIterator<Item = PathBuf>) -> Self {
        let mut catalog = Self {
            path_entries: entries.into_iter().take(MAX_PATH_ENTRIES).collect(),
            executables: BTreeMap::new(),
        };
        catalog.rebuild();
        catalog
    }

    pub(crate) fn replace_path_entries(&mut self, entries: impl IntoIterator<Item = PathBuf>) {
        self.path_entries = entries.into_iter().take(MAX_PATH_ENTRIES).collect();
        self.rebuild();
    }

    pub(crate) fn contains(&self, command: &str) -> bool {
        self.executables.contains_key(command)
    }

    pub(crate) fn commands(&self) -> impl Iterator<Item = (&str, &Path)> {
        self.executables
            .iter()
            .map(|(name, path)| (name.as_str(), path.as_path()))
    }

    fn rebuild(&mut self) {
        self.executables.clear();
        'directories: for directory in &self.path_entries {
            let Ok(entries) = fs::read_dir(directory) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if !executable_file(&path) {
                    continue;
                }
                let Some(name) = executable_name(&path) else {
                    continue;
                };
                self.executables.entry(name).or_insert(path);
                if self.executables.len() >= MAX_EXECUTABLES {
                    break 'directories;
                }
            }
        }
    }
}

pub(crate) fn executable_file(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    true
}

fn executable_name(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    #[cfg(windows)]
    {
        let extension = path.extension().and_then(|extension| extension.to_str());
        if extension.is_some_and(|extension| {
            ["com", "exe", "bat", "cmd"]
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(extension))
        }) {
            return path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .map(str::to_owned);
        }
    }
    Some(name.to_owned())
}
