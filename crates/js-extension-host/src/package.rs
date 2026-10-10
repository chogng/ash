use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

const MAX_MODULES: usize = 256;
const MAX_SOURCE_BYTES: usize = 16 * 1024 * 1024;
const MAX_MODULE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum ApiContract {
    Ash,
    Vscode,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum PackageOrigin {
    Installed,
    Product,
}

/// Immutable ESM bytes captured before extension code runs. Resolution never reads host files.
pub(crate) struct Package {
    pub(crate) origin: PackageOrigin,
    pub(crate) binding: Option<extension_protocol::PackageBinding>,
    pub(crate) api: ApiContract,
    pub(crate) extension_id: String,
    pub(crate) entry: String,
    pub(crate) sources: BTreeMap<String, String>,
}

impl Package {
    pub(crate) fn product(name: &str) -> Result<Self, String> {
        if name != "remote-ssh" {
            return Err("unknown product extension".into());
        }
        let manifest = include_str!("../../../extensions/remote-ssh/package.json");
        let source = include_str!("../../../extensions/remote-ssh/src/extension.js");
        let sdk = include_str!("../../../extension-sdk/index.js");
        let digest = format!(
            "sha256:{:x}",
            Sha256::digest(format!("{manifest}\0{source}\0{sdk}"))
        );
        Ok(Self {
            origin: PackageOrigin::Product,
            binding: Some(extension_protocol::PackageBinding {
                package_id: "ash.remote-ssh@1.0.0".into(),
                package_digest: digest,
                entrypoint: "src/extension.js".into(),
            }),
            api: ApiContract::Ash,
            extension_id: "ash.remote-ssh".into(),
            entry: "src/extension.js".into(),
            sources: BTreeMap::from([
                ("src/extension.js".into(), source.into()),
                ("@ash/extension".into(), sdk.into()),
            ]),
        })
    }

    pub(crate) fn read_vscode(
        extension_id: String,
        root: PathBuf,
        entry: String,
    ) -> Result<Self, String> {
        let mut package = Self::read(extension_id, root.clone(), entry.clone())?;
        let manifest =
            std::fs::read(root.join("package.json")).map_err(|_| "missing VS Code manifest")?;
        if manifest.len() > MAX_MODULE_BYTES as usize {
            return Err("VS Code manifest quota exceeded".into());
        }
        let manifest: serde_json::Value =
            serde_json::from_slice(&manifest).map_err(|_| "invalid VS Code manifest")?;
        let commands = manifest
            .pointer("/contributes/commands")
            .cloned()
            .unwrap_or(serde_json::json!([]));
        let publisher = manifest
            .get("publisher")
            .and_then(serde_json::Value::as_str)
            .ok_or("missing VS Code publisher")?;
        let name = manifest
            .get("name")
            .and_then(serde_json::Value::as_str)
            .ok_or("missing VS Code name")?;
        let public_extension_id = format!("{publisher}.{name}");
        let configuration = serde_json::to_string(
            &serde_json::json!({"commands": commands, "extensionId": public_extension_id}),
        )
        .map_err(|error| error.to_string())?;
        let source = package.sources.get(&entry).ok_or("missing VS Code entry")?;
        // A CommonJS bundle receives only the public editor module. It cannot obtain a Node
        // loader, host globals or package files through require, regardless of its manifest entry.
        let source = serde_json::to_string(&format!("\"use strict\";\n{source}"))
            .map_err(|error| error.to_string())?;
        let wrapper = format!(
            "import {{ createApi }} from '@ash/vscode';\nconst bridge = createApi({configuration});\nconst module = {{ exports: {{}} }};\nconst require = name => {{ if (name !== 'vscode') throw new Error('Unsupported extension module: ' + name); return bridge.api; }};\nFunction('exports', 'require', 'module', {source}).call(module.exports, module.exports, require, module);\nexport async function activate(context) {{ bridge.activate(context); const result = await module.exports.activate(context); bridge.didActivate(); return result; }}\nexport function deactivate() {{ bridge.deactivate(); return module.exports.deactivate?.(); }}\n"
        );
        package.sources.insert(entry, wrapper);
        package
            .sources
            .insert("@ash/vscode".into(), include_str!("vscode.js").into());
        package.api = ApiContract::Vscode;
        Ok(package)
    }

    pub(crate) fn read(extension_id: String, root: PathBuf, entry: String) -> Result<Self, String> {
        if !root.is_absolute() || !valid_path(&entry) || extension_id.is_empty() {
            return Err("invalid extension package binding".into());
        }
        let mut sources = BTreeMap::new();
        let mut bytes = 0;
        let mut entries = 0;
        collect(&root, &root, &mut sources, &mut bytes, &mut entries, 0)?;
        if !sources.contains_key(&entry) {
            return Err("extension entry must be an existing .js or .mjs module".into());
        }
        sources.insert(
            "@ash/extension".into(),
            include_str!("../../../extension-sdk/index.js").into(),
        );
        Ok(Self {
            origin: PackageOrigin::Installed,
            binding: None,
            api: ApiContract::Ash,
            extension_id,
            entry,
            sources,
        })
    }
}

fn collect(
    root: &Path,
    directory: &Path,
    sources: &mut BTreeMap<String, String>,
    bytes: &mut usize,
    entries: &mut usize,
    depth: usize,
) -> Result<(), String> {
    if depth > 32 {
        return Err("extension directory depth quota exceeded".into());
    }
    for entry in std::fs::read_dir(directory).map_err(|error| error.to_string())? {
        *entries += 1;
        if *entries > 4096 {
            return Err("extension package entry quota exceeded".into());
        }
        let entry = entry.map_err(|error| error.to_string())?;
        let kind = entry.file_type().map_err(|error| error.to_string())?;
        if kind.is_symlink() {
            return Err("extension module snapshot cannot contain symbolic links".into());
        }
        if kind.is_dir() {
            collect(root, &entry.path(), sources, bytes, entries, depth + 1)?;
        } else if kind.is_file()
            && matches!(
                entry.path().extension().and_then(|value| value.to_str()),
                Some("js" | "mjs")
            )
        {
            let metadata = entry.metadata().map_err(|error| error.to_string())?;
            if metadata.len() > MAX_MODULE_BYTES as u64 || sources.len() >= MAX_MODULES {
                return Err("extension module quota exceeded".into());
            }
            let text = std::fs::read_to_string(entry.path()).map_err(|error| error.to_string())?;
            *bytes += text.len();
            if *bytes > MAX_SOURCE_BYTES {
                return Err("extension source quota exceeded".into());
            }
            let path = entry.path();
            let relative = path
                .strip_prefix(root)
                .map_err(|error| error.to_string())?
                .to_str()
                .ok_or("module path is not UTF-8")?
                .replace('\\', "/");
            sources.insert(relative, text);
        }
    }
    Ok(())
}

pub(crate) fn resolve(referrer: &str, specifier: &str) -> Result<String, String> {
    if matches!(specifier, "@ash/extension" | "@ash/vscode") {
        return Ok(specifier.into());
    }
    if !specifier.starts_with("./") && !specifier.starts_with("../") {
        return Err(format!("unsupported module '{specifier}'"));
    }
    if specifier.contains('\\') || specifier.contains(':') {
        return Err("invalid module path".into());
    }
    let mut segments: Vec<&str> = referrer.split('/').collect();
    segments.pop();
    for segment in specifier.split('/') {
        match segment {
            "." => {}
            ".." => {
                if segments.pop().is_none() {
                    return Err("module import escapes its package".into());
                }
            }
            "" => return Err("invalid module path".into()),
            segment => segments.push(segment),
        }
    }
    let path = segments.join("/");
    if !valid_path(&path) {
        return Err("invalid module path".into());
    }
    Ok(path)
}

fn valid_path(value: &str) -> bool {
    !value.is_empty()
        && !value.contains(['\\', ':'])
        && Path::new(value)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}

#[cfg(test)]
#[path = "package_tests.rs"]
mod tests;
