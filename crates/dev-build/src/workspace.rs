//! Source snapshots and the owning Cargo check for module-aware compilation.
//! Generated code never substitutes a flattened crate for Rust module semantics.

use ash_rust_build_ir::Source;
use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;

#[derive(Clone)]
pub(crate) struct Package {
    pub name: String,
    pub directory: PathBuf,
}

#[derive(Clone, Default)]
pub(crate) struct Snapshot {
    pub files: BTreeMap<String, String>,
}

impl Package {
    pub(crate) fn verify_library(
        &self,
        repository: &Path,
        program: &ash_rust_build_ir::Program,
    ) -> Result<(), String> {
        let text = std::fs::read_to_string(self.directory.join("Cargo.toml"))
            .map_err(|error| error.to_string())?;
        let manifest: toml::Value = toml::from_str(&text).map_err(|error| error.to_string())?;
        let path = manifest
            .get("lib")
            .and_then(|library| library.get("path"))
            .and_then(toml::Value::as_str)
            .unwrap_or("src/lib.rs");
        let root = self
            .directory
            .join(path)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let repository = repository
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let relative = root
            .strip_prefix(&repository)
            .map_err(|_| "library root escapes workspace")?
            .to_string_lossy()
            .replace('\\', "/");
        if relative != program.crate_root {
            return Err("analysis target differs from the Cargo library target".into());
        }
        Ok(())
    }
    pub(crate) fn for_source(repository: &Path, source: &str) -> Result<Self, String> {
        let repository = repository
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let source = repository
            .join(source)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !source.starts_with(&repository)
            || source.extension().is_none_or(|extension| extension != "rs")
        {
            return Err("source must be a Rust file inside the workspace".into());
        }
        let mut directory = source.parent().ok_or("source has no parent")?;
        loop {
            let manifest = directory.join("Cargo.toml");
            if manifest.is_file() {
                let text = std::fs::read_to_string(&manifest).map_err(|error| error.to_string())?;
                let value: toml::Value =
                    toml::from_str(&text).map_err(|error| error.to_string())?;
                let name = value
                    .get("package")
                    .and_then(|package| package.get("name"))
                    .and_then(toml::Value::as_str)
                    .ok_or("source has no owning Cargo package")?;
                if name.is_empty()
                    || !name
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
                {
                    return Err("invalid Cargo package name".into());
                }
                return Ok(Self {
                    name: name.to_owned(),
                    directory: directory.to_owned(),
                });
            }
            if directory == repository {
                return Err("source has no owning Cargo package".into());
            }
            directory = directory
                .parent()
                .ok_or("source has no owning Cargo package")?;
        }
    }

    pub(crate) fn snapshot(&self, repository: &Path) -> Result<Snapshot, String> {
        let repository = repository
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let mut paths = Vec::new();
        fn visit(directory: &Path, paths: &mut Vec<PathBuf>) -> Result<(), String> {
            for entry in std::fs::read_dir(directory).map_err(|error| error.to_string())? {
                let entry = entry.map_err(|error| error.to_string())?;
                let kind = entry.file_type().map_err(|error| error.to_string())?;
                if kind.is_symlink() {
                    return Err("symbolic source files require the Cargo path".into());
                }
                if kind.is_dir() {
                    visit(&entry.path(), paths)?;
                } else if entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "rs")
                {
                    paths.push(entry.path());
                }
            }
            Ok(())
        }
        visit(&self.directory.join("src"), &mut paths)?;
        paths.push(self.directory.join("Cargo.toml"));
        if self.directory.join("build.rs").is_file() {
            paths.push(self.directory.join("build.rs"));
        }
        paths.extend(
            [
                "Cargo.toml",
                "Cargo.lock",
                ".cargo/config.toml",
                "rust-toolchain.toml",
            ]
            .map(|path| repository.join(path))
            .into_iter()
            .filter(|path| path.is_file()),
        );
        let mut snapshot = Snapshot::default();
        let mut bytes = 0;
        for path in paths {
            let name = path
                .strip_prefix(&repository)
                .map_err(|_| "package source escapes the workspace")?
                .to_string_lossy()
                .replace('\\', "/");
            let length = std::fs::metadata(&path)
                .map_err(|error| error.to_string())?
                .len();
            if length > 2 * 1024 * 1024 {
                return Err("source exceeds file budget".into());
            }
            let text = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
            bytes += text.len();
            if bytes > 16 * 1024 * 1024 || snapshot.files.len() >= 2048 {
                return Err("package snapshot exceeds budget".into());
            }
            snapshot.files.insert(name, text);
        }
        Ok(snapshot)
    }

    pub(crate) fn check_command(&self, repository: &Path) -> Command {
        let mut command = Command::new("cargo");
        command
            .current_dir(repository)
            .args([
                "check",
                "--locked",
                "--offline",
                "--package",
                &self.name,
                "--lib",
                "--profile",
                "dev-small",
                "--message-format=json-render-diagnostics",
            ])
            .stdin(Stdio::null());
        command
    }
}

impl Snapshot {
    pub(crate) fn verify_configuration(&self) -> Result<(), String> {
        // RA loads the workspace feature union; Cargo checks this library's
        // default features. Until artifact cfg is bound exactly, even a cfg on
        // an import or another caller can invalidate resolution/exclusivity.
        // Plain cfg(test) modules are absent from our non-test library target.
        struct Conditional(bool);
        impl<'ast> syn2::visit::Visit<'ast> for Conditional {
            fn visit_attribute(&mut self, attribute: &'ast syn2::Attribute) {
                self.0 |= attribute.path().is_ident("cfg") || attribute.path().is_ident("cfg_attr");
            }
            fn visit_item_mod(&mut self, module: &'ast syn2::ItemMod) {
                if module.attrs.iter().any(|attribute| {
                    matches!(&attribute.meta, syn2::Meta::List(meta)
                        if meta.path.is_ident("cfg") && meta.tokens.to_string() == "test")
                }) {
                    return;
                }
                syn2::visit::visit_item_mod(self, module);
            }
        }
        for source in self.sources() {
            let file = syn2::parse_file(&source.text).map_err(|error| error.to_string())?;
            let mut conditional = Conditional(false);
            syn2::visit::Visit::visit_file(&mut conditional, &file);
            if conditional.0 {
                return Err(format!(
                    "conditional source requires explicit artifact configuration: {}",
                    source.path
                ));
            }
        }
        Ok(())
    }

    pub(crate) fn sources(&self) -> Vec<Source> {
        self.files
            .iter()
            .filter(|(path, _)| path.ends_with(".rs") && !path.ends_with("/build.rs"))
            .map(|(path, text)| Source {
                path: path.clone(),
                text: text.clone(),
            })
            .collect()
    }

    pub(crate) fn configuration_changed(&self, previous: &Self) -> bool {
        self.files.keys().ne(previous.files.keys())
            || self.files.iter().any(|(path, text)| {
                (!path.ends_with(".rs") || path.ends_with("/build.rs"))
                    && previous.files.get(path) != Some(text)
            })
    }

    pub(crate) fn verify_program(
        &self,
        program: &ash_rust_build_ir::Program,
    ) -> Result<(), String> {
        for source in &program.sources {
            if self.files.get(&source.path) != Some(&source.text) {
                return Err(format!(
                    "analysis source is stale or outside the package: {}",
                    source.path
                ));
            }
        }
        Ok(())
    }

    pub(crate) fn digest(&self) -> String {
        crate::reload::digest(
            serde_json::to_string(&self.files)
                .expect("string map is serializable")
                .as_bytes(),
        )
    }
}

#[cfg(test)]
#[path = "workspace_tests.rs"]
mod tests;
