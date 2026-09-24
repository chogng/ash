use std::path::Path;

use super::BundleError;
use super::BundleManifest;
use super::BundleOutput;
use super::copy;
use super::xml_escape;

pub(super) fn build(manifest: &BundleManifest, output: &Path) -> Result<BundleOutput, BundleError> {
    let root = output.join(format!("{}.app", manifest.name));
    copy::create_root(&root)?;
    let result = build_inside(manifest, &root);
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&root);
    }
    result
}

fn build_inside(manifest: &BundleManifest, root: &Path) -> Result<BundleOutput, BundleError> {
    let contents = root.join("Contents");
    let executable_directory = contents.join("MacOS");
    let resources = contents.join("Resources");
    std::fs::create_dir_all(&executable_directory).map_err(BundleError::source)?;
    std::fs::create_dir_all(&resources).map_err(BundleError::source)?;
    let executable = executable_directory.join(&manifest.name);
    copy::copy_file(&manifest.executable, &executable)?;
    copy::make_executable(&executable)?;
    copy::copy_resources(manifest, &resources)?;
    let icon_name = if let Some(icon) = &manifest.icon {
        let name = icon
            .file_name()
            .ok_or_else(|| BundleError::message("icon path has no file name"))?;
        copy::copy_file(icon, &resources.join(name))?;
        Some(name.to_string_lossy().into_owned())
    } else {
        None
    };
    let protocol_xml = manifest
        .protocols
        .iter()
        .map(|scheme| {
            format!(
                "<dict><key>CFBundleURLName</key><string>{}</string><key>CFBundleURLSchemes</key><array><string>{}</string></array></dict>",
                xml_escape(manifest.identifier.as_str()),
                xml_escape(scheme.as_str())
            )
        })
        .collect::<String>();
    let icon_xml = icon_name
        .map(|name| {
            format!(
                "<key>CFBundleIconFile</key><string>{}</string>",
                xml_escape(&name)
            )
        })
        .unwrap_or_default();
    let plist = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"><plist version=\"1.0\"><dict><key>CFBundleDisplayName</key><string>{name}</string><key>CFBundleExecutable</key><string>{name}</string><key>CFBundleIdentifier</key><string>{identifier}</string><key>CFBundleName</key><string>{name}</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>{version}</string><key>CFBundleVersion</key><string>{version}</string><key>NSHighResolutionCapable</key><true/>{icon}<key>CFBundleURLTypes</key><array>{protocols}</array></dict></plist>",
        name = xml_escape(&manifest.name),
        identifier = xml_escape(manifest.identifier.as_str()),
        version = xml_escape(&manifest.version.platform_release()),
        icon = icon_xml,
        protocols = protocol_xml,
    );
    let protocol_manifest = contents.join("Info.plist");
    std::fs::write(&protocol_manifest, plist).map_err(BundleError::source)?;
    Ok(BundleOutput {
        root: root.to_path_buf(),
        executable,
        protocol_manifest,
        helpers: Vec::new(),
    })
}
