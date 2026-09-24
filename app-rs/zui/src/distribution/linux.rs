use std::path::Path;

use super::BundleError;
use super::BundleManifest;
use super::BundleOutput;
use super::copy;

pub(super) fn build(manifest: &BundleManifest, output: &Path) -> Result<BundleOutput, BundleError> {
    let root = output.join(format!("{}.AppDir", manifest.name));
    copy::create_root(&root)?;
    let result = build_inside(manifest, &root);
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&root);
    }
    result
}

fn build_inside(manifest: &BundleManifest, root: &Path) -> Result<BundleOutput, BundleError> {
    let bin = root.join("usr/bin");
    let resources = bin.join("resources");
    let applications = root.join("usr/share/applications");
    std::fs::create_dir_all(&bin).map_err(BundleError::source)?;
    std::fs::create_dir_all(&applications).map_err(BundleError::source)?;
    let executable = bin.join(&manifest.name);
    copy::copy_file(&manifest.executable, &executable)?;
    copy::make_executable(&executable)?;
    copy::copy_resources(manifest, &resources)?;
    let mime_types = manifest
        .protocols
        .iter()
        .map(|scheme| format!("x-scheme-handler/{};", scheme.as_str()))
        .collect::<String>();
    let icon = copy_icon(manifest, root)?;
    let desktop = format!(
        "[Desktop Entry]\nType=Application\nName={}\nExec={} %u\nTerminal=false\nMimeType={}\n{}",
        manifest.name,
        desktop_exec_quote(&manifest.name),
        mime_types,
        icon.as_deref()
            .map(|name| format!("Icon={name}\n"))
            .unwrap_or_default()
    );
    let protocol_manifest = root.join(format!("{}.desktop", manifest.identifier.0));
    std::fs::write(&protocol_manifest, desktop).map_err(BundleError::source)?;
    copy::copy_file(
        &protocol_manifest,
        &applications.join(format!("{}.desktop", manifest.identifier.0)),
    )?;
    let launcher = format!(
        "#!/bin/sh\nAPPDIR=${{APPDIR:-$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)}}\nexec \"$APPDIR/usr/bin/{}\" \"$@\"\n",
        shell_double_quote_fragment(&manifest.name)
    );
    let app_run = root.join("AppRun");
    std::fs::write(&app_run, launcher).map_err(BundleError::source)?;
    copy::make_executable(&app_run)?;
    Ok(BundleOutput {
        root: root.to_path_buf(),
        executable,
        protocol_manifest,
        helpers: Vec::new(),
    })
}

fn copy_icon(manifest: &BundleManifest, root: &Path) -> Result<Option<String>, BundleError> {
    let Some(icon) = &manifest.icon else {
        return Ok(None);
    };
    let extension = icon
        .extension()
        .and_then(|extension| extension.to_str())
        .ok_or_else(|| BundleError::message("Linux bundle icon needs a file extension"))?;
    let name = format!("{}.{}", manifest.name, extension);
    copy::copy_file(icon, &root.join(&name))?;
    copy::copy_file(icon, &root.join(".DirIcon"))?;
    Ok(Some(manifest.name.clone()))
}

fn desktop_exec_quote(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('`', "\\`")
            .replace('$', "\\$")
    )
}

fn shell_double_quote_fragment(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('`', "\\`")
        .replace('$', "\\$")
}
