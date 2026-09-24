use std::path::Path;

use super::BundleError;
use super::BundleManifest;
use super::BundleOutput;
use super::copy;

pub(super) fn build(manifest: &BundleManifest, output: &Path) -> Result<BundleOutput, BundleError> {
    let root = output.join(format!("{}-windows", manifest.name));
    copy::create_root(&root)?;
    let result = build_inside(manifest, &root);
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&root);
    }
    result
}

fn build_inside(manifest: &BundleManifest, root: &Path) -> Result<BundleOutput, BundleError> {
    let executable_name = if manifest.name.to_ascii_lowercase().ends_with(".exe") {
        manifest.name.clone()
    } else {
        format!("{}.exe", manifest.name)
    };
    let executable = root.join(&executable_name);
    copy::copy_file(&manifest.executable, &executable)?;
    let helpers = if let Some(runner) = &manifest.windows_appcontainer_runner {
        let destination = root.join("zui-appcontainer-runner.exe");
        copy::copy_file(runner, &destination)?;
        vec![destination]
    } else {
        Vec::new()
    };
    copy::copy_resources(manifest, &root.join("resources"))?;
    let mut registry = format!(
        "$exe = Join-Path $PSScriptRoot '{}'
",
        executable_name.replace('\'', "''")
    );
    for scheme in &manifest.protocols {
        let scheme = scheme.as_str();
        registry.push_str(&format!(
            "$root = 'HKCU:\\Software\\Classes\\{scheme}'\r\nNew-Item -Path $root -Force | Out-Null\r\nSet-Item -Path $root -Value 'URL:{scheme}'\r\nNew-ItemProperty -Path $root -Name 'URL Protocol' -Value '' -Force | Out-Null\r\n$command = Join-Path $root 'shell\\open\\command'\r\nNew-Item -Path $command -Force | Out-Null\r\nSet-Item -Path $command -Value ('\"' + $exe + '\" \"%1\"')\r\n\r\n"
        ));
    }
    let protocol_manifest = root.join("register-protocols.ps1");
    std::fs::write(&protocol_manifest, registry).map_err(BundleError::source)?;
    Ok(BundleOutput {
        root: root.to_path_buf(),
        executable,
        protocol_manifest,
        helpers,
    })
}
