//! Opens user-selected configuration files in the host's graphical text editor.

use std::path::Path;
use std::process::Command;

pub(crate) fn open(path: &Path, language: crate::nls::Language) -> Result<String, String> {
    prepare_file(path).map_err(|error| crate::nls::localize_owned(language, &error.to_string()))?;
    let status = editor_command(path)
        .status()
        .map_err(|error| error.to_string())?;
    if status.success() {
        Ok(crate::nls::localize_owned(
            language,
            "Configuration opened; save the file and press r to refresh Hooks",
        ))
    } else {
        Err(crate::nls::localize_owned(
            language,
            "The text editor could not open the configuration",
        ))
    }
}

fn prepare_file(path: &Path) -> std::io::Result<()> {
    if !path.is_absolute() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Configuration path must be absolute",
        ));
    }
    std::fs::create_dir_all(
        path.parent()
            .expect("absolute configuration path has a parent"),
    )?;
    // Opening an absent project document creates an empty TOML, never overwrites an existing one.
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(target_os = "macos")]
fn editor_command(path: &Path) -> Command {
    let mut command = Command::new("open");
    command.arg("-t").arg(path);
    command
}

#[cfg(target_os = "windows")]
fn editor_command(path: &Path) -> Command {
    let mut command = Command::new("notepad.exe");
    command.arg(path);
    command
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn editor_command(path: &Path) -> Command {
    let mut command = Command::new("xdg-open");
    command.arg(path);
    command
}

#[cfg(test)]
#[path = "text_editor_tests.rs"]
mod tests;
