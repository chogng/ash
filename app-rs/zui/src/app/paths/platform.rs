use std::collections::BTreeMap;
use std::path::PathBuf;

use super::ApplicationPath;
use super::ApplicationPathError;

pub(super) struct ApplicationPathEnvironment {
    pub(super) values: BTreeMap<ApplicationPath, PathBuf>,
    pub(super) logs_root: Option<PathBuf>,
}

impl ApplicationPathEnvironment {
    pub(super) fn detect() -> Result<Self, ApplicationPathError> {
        let executable =
            std::env::current_exe().map_err(ApplicationPathError::current_executable)?;
        let mut values = BTreeMap::new();
        values.insert(ApplicationPath::Executable, executable.clone());
        values.insert(ApplicationPath::Module, executable.clone());
        values.insert(ApplicationPath::Temporary, std::env::temp_dir());
        insert_optional(&mut values, ApplicationPath::Home, dirs::home_dir());
        insert_optional(&mut values, ApplicationPath::AppData, dirs::config_dir());
        insert_optional(&mut values, ApplicationPath::Desktop, dirs::desktop_dir());
        insert_optional(
            &mut values,
            ApplicationPath::Documents,
            dirs::document_dir(),
        );
        insert_optional(
            &mut values,
            ApplicationPath::Downloads,
            dirs::download_dir(),
        );
        insert_optional(&mut values, ApplicationPath::Music, dirs::audio_dir());
        insert_optional(&mut values, ApplicationPath::Pictures, dirs::picture_dir());
        insert_optional(&mut values, ApplicationPath::Videos, dirs::video_dir());
        #[cfg(any(target_os = "linux", target_os = "windows"))]
        if let Some(parent) = executable.parent() {
            values.insert(ApplicationPath::Assets, parent.to_path_buf());
        }
        #[cfg(target_os = "windows")]
        if let Some(app_data) = dirs::data_dir() {
            values.insert(
                ApplicationPath::Recent,
                app_data.join("Microsoft").join("Windows").join("Recent"),
            );
        }
        #[cfg(target_os = "macos")]
        let logs_root = dirs::home_dir().map(|home| home.join("Library").join("Logs"));
        #[cfg(not(target_os = "macos"))]
        let logs_root = None;
        Ok(Self { values, logs_root })
    }
}

fn insert_optional(
    values: &mut BTreeMap<ApplicationPath, PathBuf>,
    name: ApplicationPath,
    path: Option<PathBuf>,
) {
    if let Some(path) = path {
        values.insert(name, path);
    }
}
