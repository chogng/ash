use std::path::Path;

use sha2::Digest;
use sha2::Sha256;

use super::InstallerError;
use crate::distribution::BundleManifest;
use crate::distribution::BundleOutput;
use crate::distribution::xml_escape;

pub(super) fn definition(
    manifest: &BundleManifest,
    bundle: &BundleOutput,
) -> Result<String, InstallerError> {
    let mut component_ids = Vec::new();
    let mut next_id = 0_u64;
    let directory_xml = directory_contents(&bundle.root, &mut next_id, &mut component_ids)?;
    let executable = bundle
        .executable
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| InstallerError::message("bundle executable name is not UTF-8"))?;
    let executable = xml_escape(executable);
    let protocol_xml = manifest
        .protocols
        .iter()
        .enumerate()
        .map(|(index, scheme)| {
            let component = format!("ProtocolComponent{index}");
            component_ids.push(component.clone());
            let scheme = xml_escape(scheme.as_str());
            format!(
                "<Component Id=\"{component}\" Guid=\"*\"><RegistryValue Root=\"HKCU\" Key=\"Software\\Classes\\{scheme}\" Value=\"URL:{scheme}\" KeyPath=\"yes\"/><RegistryValue Root=\"HKCU\" Key=\"Software\\Classes\\{scheme}\" Name=\"URL Protocol\" Value=\"\"/><RegistryValue Root=\"HKCU\" Key=\"Software\\Classes\\{scheme}\\shell\\open\\command\" Value=\"&quot;[INSTALLFOLDER]{executable}&quot; &quot;%1&quot;\"/></Component>",
            )
        })
        .collect::<String>();
    let component_refs = component_ids
        .iter()
        .map(|id| format!("<ComponentRef Id=\"{id}\"/>"))
        .collect::<String>();
    Ok(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Wix xmlns=\"http://wixtoolset.org/schemas/v4/wxs\"><Package Name=\"{name}\" Manufacturer=\"{name}\" Version=\"{version}\" UpgradeCode=\"{upgrade_code}\" Scope=\"perUser\"><MajorUpgrade DowngradeErrorMessage=\"A newer version is already installed.\"/><MediaTemplate EmbedCab=\"yes\"/><StandardDirectory Id=\"LocalAppDataFolder\"><Directory Id=\"INSTALLFOLDER\" Name=\"{name}\">{directory_xml}{protocol_xml}</Directory></StandardDirectory><Feature Id=\"Main\" Title=\"{name}\" Level=\"1\">{component_refs}</Feature></Package></Wix>",
        name = xml_escape(&manifest.name),
        version = xml_escape(&manifest.version.platform_release()),
        upgrade_code = upgrade_code(manifest.identifier.as_str()),
    ))
}

fn directory_contents(
    directory: &Path,
    next_id: &mut u64,
    component_ids: &mut Vec<String>,
) -> Result<String, InstallerError> {
    let mut entries = std::fs::read_dir(directory)
        .map_err(InstallerError::source)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(InstallerError::source)?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    let mut xml = String::new();
    for entry in entries {
        let metadata = std::fs::symlink_metadata(entry.path()).map_err(InstallerError::source)?;
        if metadata.file_type().is_symlink() {
            return Err(InstallerError::message(
                "Windows installer input cannot contain symbolic links",
            ));
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| InstallerError::message("bundle path is not UTF-8"))?;
        let id = *next_id;
        *next_id += 1;
        if metadata.is_dir() {
            let children = directory_contents(&entry.path(), next_id, component_ids)?;
            xml.push_str(&format!(
                "<Directory Id=\"Directory{id}\" Name=\"{}\">{children}</Directory>",
                xml_escape(&name)
            ));
        } else if metadata.is_file() {
            let component = format!("FileComponent{id}");
            component_ids.push(component.clone());
            let source = entry
                .path()
                .canonicalize()
                .map_err(InstallerError::source)?;
            let source = source
                .to_str()
                .ok_or_else(|| InstallerError::message("bundle source path is not UTF-8"))?;
            xml.push_str(&format!(
                "<Component Id=\"{component}\" Guid=\"*\"><File Id=\"File{id}\" Name=\"{}\" Source=\"{}\" KeyPath=\"yes\"/></Component>",
                xml_escape(&name),
                xml_escape(source)
            ));
        } else {
            return Err(InstallerError::message(
                "Windows installer input must contain only regular files and directories",
            ));
        }
    }
    Ok(xml)
}

fn upgrade_code(identifier: &str) -> String {
    let mut bytes: [u8; 16] = Sha256::digest(identifier.as_bytes())[..16]
        .try_into()
        .expect("SHA-256 always contains sixteen bytes");
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{{{:02X}{:02X}{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}}}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}
