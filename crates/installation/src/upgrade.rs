use crate::files;
use crate::invalid;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Component;
use std::path::Path;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: u8,
    files: BTreeMap<String, String>,
}

fn read(path: &Path) -> io::Result<Manifest> {
    let manifest: Manifest =
        serde_json::from_slice(&files::read_bounded_with_limit(path, 16 * 1024 * 1024)?)
            .map_err(invalid)?;
    if manifest.schema_version != 1 {
        return Err(invalid("unknown installation manifest version"));
    }
    for (name, hash) in &manifest.files {
        if name.is_empty()
            || name.contains(['\\', ':'])
            || !Path::new(name)
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
            || hash.len() != 64
            || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(invalid("unsafe installation manifest entry"));
        }
    }
    Ok(manifest)
}

/// Removes files dropped by the incoming release only when the installed bytes
/// still match the previous receipt. Unknown and modified user files survive.
pub(crate) fn prepare(root: &Path, incoming: &Path) -> io::Result<()> {
    if !root.exists() {
        return Ok(());
    }
    let root = files::real_directory(root)?;
    if !eligible(&root)? {
        return Err(invalid(
            "installation contains links or repositories; upgrade cannot safely replace its files",
        ));
    }
    if root.join(".git").exists() {
        return Err(invalid("installation directory is a user worktree"));
    }
    let old = root.join("resources/installation-files.json");
    if !old.exists() {
        return Ok(());
    }
    let old = read(&old)?;
    let incoming = read(incoming)?;
    for (name, expected) in old.files {
        if incoming.files.contains_key(&name) {
            continue;
        }
        let path = root.join(&name);
        if path
            .ancestors()
            .take_while(|ancestor| *ancestor != root)
            .any(|ancestor| ancestor.join(".git").exists())
        {
            continue;
        }
        if !path.exists() {
            continue;
        }
        let parent = path
            .parent()
            .ok_or_else(|| invalid("manifest entry has no parent"))?;
        if files::real_directory(parent).is_err()
            || files::require_regular_or_missing(&path).is_err()
        {
            continue;
        }
        if files::file_hash(&path)? != expected {
            continue;
        }
        fs::remove_file(&path)?;
        let mut parent = parent.to_owned();
        while parent != root && fs::read_dir(&parent)?.next().is_none() {
            fs::remove_dir(&parent)?;
            parent = parent
                .parent()
                .ok_or_else(|| invalid("installation path escaped root"))?
                .to_owned();
        }
    }
    Ok(())
}

pub(crate) fn eligible(root: &Path) -> io::Result<bool> {
    let path = root.join("resources/installation-files.json");
    let manifest = if path.exists() {
        read(&path)?.files
    } else {
        BTreeMap::new()
    };
    files::eligible_installation(root, &manifest)
}

pub(crate) fn installed_files(root: &Path) -> io::Result<Vec<std::path::PathBuf>> {
    let manifest = root.join("resources/installation-files.json");
    let mut paths = if manifest.exists() {
        read(&manifest)?
            .files
            .keys()
            .map(|name| root.join(name))
            .collect()
    } else {
        vec![root.join("Ash.exe")]
    };
    paths.push(manifest);
    Ok(paths)
}
