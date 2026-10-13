use std::collections::BTreeMap;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

const MAX_MODULES: usize = 256;
const MAX_SOURCE_BYTES: usize = 16 * 1024 * 1024;
const MAX_MODULE_BYTES: usize = 4 * 1024 * 1024;

/// Immutable package bytes captured before extension code runs. Resolution never reads host files.
pub(crate) struct Package {
    pub(crate) extension_id: String,
    pub(crate) entry: String,
    pub(crate) sources: BTreeMap<String, String>,
}

impl Package {
    pub(crate) fn read_vscode(
        extension_id: String,
        root: PathBuf,
        entry: String,
    ) -> Result<Self, String> {
        let mut package = Self::read_package(extension_id, &root, entry.clone())?;
        let manifest = package
            .sources
            .get("package.json")
            .ok_or("missing VS Code manifest")?;
        let manifest: serde_json::Value =
            serde_json::from_str(manifest).map_err(|_| "invalid VS Code manifest")?;
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
            &serde_json::json!({
                "commands": commands,
                "extensionId": public_extension_id,
                "debuggers": manifest.pointer("/contributes/debuggers").cloned().unwrap_or(serde_json::json!([])),
                "extensionPath": root.to_str().ok_or("package root is not UTF-8")?,
                "pathSeparator": std::path::MAIN_SEPARATOR.to_string(),
                "manifest": manifest,
            }),
        )
        .map_err(|error| error.to_string())?;
        // Package files are function bodies/data, not ESM imports. The loader reads only
        // this captured map after confinement and shares one cache throughout the incarnation.
        // Defer package evaluation until its window facts are bound and host activation has begun.
        let sources = serde_json::to_string(
            &serde_json::to_string(&package.sources).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let root = serde_json::to_string(root.to_str().ok_or("package root is not UTF-8")?)
            .map_err(|error| error.to_string())?;
        let entry_name = serde_json::to_string(&entry).map_err(|error| error.to_string())?;
        let separator = serde_json::to_string(&std::path::MAIN_SEPARATOR.to_string())
            .map_err(|error| error.to_string())?;
        let wrapper = format!(
            "import {{ createApi }} from '@ash/vscode';\nimport {{ loadCommonJS }} from '@ash/commonjs';\nlet bridge, module;\nexport async function activate(context, capabilities, initialization) {{ bridge = createApi({configuration}, JSON.parse(initialization)); module = loadCommonJS(JSON.parse({sources}), {root}, {separator}, {entry_name}, bridge.api); return bridge.activate(context, module.exports.activate, module.exports, JSON.parse(capabilities)); }}\nexport function deactivate() {{ bridge?.deactivate(); return module?.exports.deactivate?.(); }}\n"
        );
        package.sources.clear();
        package.sources.insert(entry, wrapper);
        package.sources.insert(
            "@ash/host".into(),
            include_str!("../../../resources/extension-host/host.mjs").into(),
        );
        package.sources.insert(
            "@ash/vscode".into(),
            include_str!("../../../resources/extension-host/vscode.js").into(),
        );
        package.sources.insert(
            "@ash/scm.js".into(),
            include_str!("../../../resources/extension-host/scm.js").into(),
        );
        package
            .sources
            .insert("@ash/commonjs".into(), include_str!("commonjs.js").into());
        Ok(package)
    }

    pub(crate) fn read(extension_id: String, root: PathBuf, entry: String) -> Result<Self, String> {
        Self::read_vscode(extension_id, root, entry)
    }

    fn read_package(extension_id: String, root: &Path, entry: String) -> Result<Self, String> {
        if !root.is_absolute() || !valid_path(&entry) || extension_id.is_empty() {
            return Err("invalid extension package binding".into());
        }
        let mut sources = BTreeMap::new();
        let mut bytes = 0;
        let mut entries = 0;
        collect(root, root, &mut sources, &mut bytes, &mut entries, 0)?;
        let extension = Path::new(&entry)
            .extension()
            .and_then(|value| value.to_str());
        if !sources.contains_key(&entry)
            || !(matches!(extension, Some("js" | "mjs")) || extension == Some("cjs"))
        {
            return Err("extension entry must be an existing JavaScript module".into());
        }
        Ok(Self {
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
            && (matches!(
                entry.path().extension().and_then(|value| value.to_str()),
                Some("js" | "mjs")
            ) || matches!(
                entry.path().extension().and_then(|value| value.to_str()),
                Some("cjs" | "json")
            ))
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
    if referrer == "@ash/vscode" && specifier == "./host.mjs" {
        return Ok("@ash/host".into());
    }
    if matches!(specifier, "@ash/vscode" | "@ash/commonjs") {
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
